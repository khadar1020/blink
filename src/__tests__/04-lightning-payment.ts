/**
 * @jest-environment node
 */
import { createHash, randomBytes } from 'crypto';
import { quit } from "../lock";
import { InvoiceUser, MainBook, setupMongoConnection, Transaction, User } from "../mongodb";
import { checkIsBalanced, getUserWallet, lndOutside1, lndOutside2, onBoardingEarnAmt, onBoardingEarnIds } from "../tests/helper";
import { getHash } from "../utils";
import { getFunderWallet } from "../walletFactory";
const lnService = require('ln-service')
const mongoose = require("mongoose")

let userWallet1, userWallet2
let initBalance1, initBalance2

const amountInvoice = 1000

beforeAll(async () => {
  await setupMongoConnection()
  userWallet1 = await getUserWallet(1)
  userWallet2 = await getUserWallet(2)
});

beforeEach(async () => {
  initBalance1 = await userWallet1.getBalance()
  initBalance2 = await userWallet2.getBalance()
})

afterAll(async () => {
  // to make this test re-entrant, we need to remove the fund from userWallet1 and delete the user
  const finalBalance = await userWallet1.getBalance()
  const funderWallet = await getFunderWallet()
  const request = await funderWallet.addInvoice({value: finalBalance})
  await userWallet1.pay({request})
  await User.findOneAndRemove({_id: userWallet1.uid})

  await mongoose.connection.close()
  await quit()
});


it('add invoice', async () => {
  const request = await userWallet1.addInvoice({ value: 1000 })
  expect(request.startsWith("lnbcrt10")).toBeTruthy()
  const { uid } = await InvoiceUser.findById(getHash(request))
  expect(uid).toBe(userWallet1.uid)
})

it('add invoice to different user', async () => {
  const request = await userWallet2.addInvoice({ value: 1000000 })
  const { uid } = await InvoiceUser.findById(getHash(request))
  expect(uid).toBe(userWallet2.uid)
})

it('add invoice with no amount', async () => {
  const request = await userWallet2.addInvoice({})
  const { uid } = await InvoiceUser.findById(getHash(request))
  expect(uid).toBe(userWallet2.uid)
})

it('add earn adds balance correctly', async () => {
  const getAndVerifyRewards = async () => {
    await userWallet1.addEarn(onBoardingEarnIds)
    const finalBalance = await userWallet1.getBalance()
    expect(finalBalance).toBe(onBoardingEarnAmt)
    await checkIsBalanced()
  }

  await getAndVerifyRewards()
  
  // yet, if we do it another time, the balance should not increase, 
  // because all the rewards has already been been consumed:
  await getAndVerifyRewards()
}, 15000)

it('payInvoice', async () => {
  const { request } = await lnService.createInvoice({ lnd: lndOutside1, tokens: amountInvoice })
  const result = await userWallet1.pay({ invoice: request })
  expect(result).toBe("success")
  const finalBalance = await userWallet1.getBalance()
  expect(finalBalance).toBe(initBalance1 - amountInvoice)
  await checkIsBalanced()
}, 50000)

it('receives payment from outside', async () => {
  const memo = "myMemo"

  const request = await userWallet1.addInvoice({ value: amountInvoice, memo })
  await lnService.pay({ lnd: lndOutside1, request })
  const finalBalance = await userWallet1.getBalance()
  expect(finalBalance).toBe(initBalance1 + amountInvoice)

  const mongotx = await Transaction.findOne({hash: getHash(request)})
  expect(mongotx.memo).toBe(memo)
  await checkIsBalanced()
}, 50000)

it('fails to pay when user has insufficient balance', async () => {
  const { request } = await lnService.createInvoice({ lnd: lndOutside1, tokens: initBalance1 + 1000000 })
  //FIXME: Check exact error message also
  await expect(userWallet1.pay({ invoice: request })).rejects.toThrow()
})

it('payInvoiceToAnotherGaloyUser', async () => {
  const request = await userWallet2.addInvoice({ value: amountInvoice })
  await userWallet1.pay({ invoice: request })

  const user1FinalBalance = await userWallet1.getBalance()
  const user2FinalBalance = await userWallet2.getBalance()
  
  expect(user1FinalBalance).toBe(initBalance1 - amountInvoice)
  expect(user2FinalBalance).toBe(initBalance2 + amountInvoice)
  
  const matchTx = tx => tx.type === 'on_us' && tx.hash === getHash(request)

  const user1Txn = await userWallet1.getTransactions()
  const user1OnUsTxn = user1Txn.filter(matchTx)
  expect(user1OnUsTxn[0].description).toBe('Payment sent')

  const user2Txn = await userWallet2.getTransactions()
  const user2OnUsTxn = user2Txn.filter(matchTx)
  expect(user2OnUsTxn[0].description).toBe('Payment received')
  await checkIsBalanced()
}, 50000)

it('payInvoiceToSelf', async () => {
  const invoice = await userWallet1.addInvoice({ value: 1000, memo: "self payment" })
  await expect(userWallet1.pay({ invoice })).rejects.toThrow()
}, 50000)

it('pushPayment', async () => {
  const destination = (await lnService.getWalletInfo({ lnd: lndOutside1 })).public_key;
  const res = await userWallet1.pay({ destination, amount: amountInvoice })
  const finalBalance = await userWallet1.getBalance()
  expect(res).toBe("success")
  expect(finalBalance).toBe(initBalance1 - amountInvoice)
  await checkIsBalanced()
}, 50000)

it('fails to pay when channel capacity exceeded', async () => {
  const { request } = await lnService.createInvoice({ lnd: lndOutside1, tokens: 15000000 })

  let didThrow = false

  // FIXME: below statement fails due to some reason, so using try catch for now
  // await expect(userWallet1.pay({ invoice: request })).rejects.toThrow()
  try {
    await userWallet1.pay({ invoice: request })
  } catch (error) {
    didThrow = true
  }
  //FIXME: Are single line if bad design?
  if (!didThrow) fail('Function did not fail')
  await checkIsBalanced()
}, 50000)

it('pay hodl invoice', async () => {
  const randomSecret = () => randomBytes(32);
  const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
  const secret = randomSecret();
  const id = sha256(secret);

  const { request } = await lnService.createHodlInvoice({ id, lnd: lndOutside1, tokens: amountInvoice });
  const result = await userWallet1.pay({ invoice: request })

  expect(result).toBe("pending")
  const finalBalance = await userWallet1.getBalance()
  // FIXME: necessary to not have openHandler ?
  // https://github.com/alexbosworth/ln-service/issues/122
  await lnService.settleHodlInvoice({ lnd: lndOutside1, secret: secret.toString('hex') });
  expect(finalBalance).toBe(initBalance1 - amountInvoice)
  await checkIsBalanced()
}, 50000)

it('payInvoice to lnd outside 2', async () => {
  const { request } = await lnService.createInvoice({ lnd: lndOutside2, tokens: amountInvoice, is_including_private_channels: true })
  const { id } = await lnService.decodePaymentRequest({ lnd: lndOutside2, request })

  const initialBalance = await userWallet1.getBalance()

  const result = await userWallet1.pay({ invoice: request })
  expect(result).toBe("success")
  const finalBalance = await userWallet1.getBalance()

  const { results: [{ fee }] } = await MainBook.ledger({ account: userWallet1.accountPath, hash: id })
  expect(finalBalance).toBe(initialBalance - amountInvoice - fee)
  await checkIsBalanced()
}, 100000)

it('if fee are too high, payment is cancelled', async () => {
  // TODO
})

it('pays zero amount invoice', async () => {
  const { request } = await lnService.createInvoice({ lnd: lndOutside1 })
  const initialBalance = await userWallet1.getBalance()
  const result = await userWallet1.pay({ invoice: request, amount: amountInvoice })
  expect(result).toBe("success")
  const finalBalance = await userWallet1.getBalance()
  expect(finalBalance).toBe(initialBalance - amountInvoice)
  await checkIsBalanced()
}, 100000)

it('receive zero amount invoice', async () => {
  const initialBalance = await userWallet1.getBalance()
  const invoice = await userWallet1.addInvoice()
  await lnService.pay({ lnd: lndOutside1, request: invoice, tokens: amountInvoice })
  const finalBalance = await userWallet1.getBalance()
  expect(finalBalance).toBe(initialBalance + amountInvoice)
  await checkIsBalanced()
}, 100000)

it('fails to pay zero amt invoice without separate amt', async () => {
  const { request } = await lnService.createInvoice({ lnd: lndOutside1 })
  await expect(userWallet1.pay({ invoice: request })).rejects.toThrow()
})

it('fails to pay regular invoice with separate amt', async () => {
  const { request } = await lnService.createInvoice({ lnd: lndOutside1, tokens: amountInvoice })
  await expect(userWallet1.pay({ invoice: request, amount: amountInvoice })).rejects.toThrow()
})



// it('testDbTransaction', async () => {
//   //TODO try to fetch simulataneously (ie: with Premise.all[])
//   // balances with pending but settled transaction to see if 
//   // we can create a race condition in the DB
// })