import * as admin from "firebase-admin"

import {
  DeviceTokensNotRegisteredNotificationsServiceError,
  InvalidDeviceNotificationsServiceError,
  NotificationChannel,
  NotificationsServiceError,
  NotificationsServiceUnreachableServerError,
  UnknownNotificationsServiceError,
  shouldSendNotification,
} from "@domain/notifications"
import { ErrorLevel, parseErrorMessageFromUnknown } from "@domain/shared"
import { baseLogger } from "@services/logger"
import {
  addAttributesToCurrentSpan,
  recordExceptionInCurrentSpan,
  wrapAsyncToRunInSpan,
} from "@services/tracing"
import { Messaging } from "firebase-admin/lib/messaging/messaging"

import { GOOGLE_APPLICATION_CREDENTIALS } from "@config"

const logger = baseLogger.child({ module: "notifications" })

type MessagingPayload = admin.messaging.MessagingPayload
type NotificationMessagePayload = admin.messaging.NotificationMessagePayload

let messaging: Messaging

if (GOOGLE_APPLICATION_CREDENTIALS) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  })

  messaging = admin.messaging()
}

const sendToDevice = async (
  tokens: DeviceToken[],
  message: MessagingPayload & {
    notification: NotificationMessagePayload
  },
) => {
  try {
    if (!messaging) {
      baseLogger.info("messaging module not loaded")
      // FIXME: should return an error?
      return true
    }

    const response = await messaging.sendToDevice(tokens, message)
    logger.info({ response, tokens, message }, "notification was sent successfully")

    const invalidTokens: DeviceToken[] = []
    response.results.forEach((item, index: number) => {
      if (
        response.results.length === tokens.length &&
        item?.error?.code === "messaging/registration-token-not-registered"
      ) {
        invalidTokens.push(tokens[index])
      }
      if (item?.error?.message) {
        recordExceptionInCurrentSpan({
          error: new InvalidDeviceNotificationsServiceError(item.error.message),
          level: ErrorLevel.Info,
        })
      }
    })

    addAttributesToCurrentSpan({
      failureCount: response.failureCount,
      successCount: response.successCount,
      canonicalRegistrationTokenCount: response.canonicalRegistrationTokenCount,
    })

    if (invalidTokens.length > 0) {
      return new DeviceTokensNotRegisteredNotificationsServiceError(invalidTokens)
    }

    return true
  } catch (err) {
    logger.error({ err, tokens, message }, "impossible to send notification")
    const error = handleCommonNotificationErrors(err)
    recordExceptionInCurrentSpan({ error, level: ErrorLevel.Warn })
    return error
  }
}

export const PushNotificationsService = (): IPushNotificationsService => {
  const sendNotification = async ({
    deviceTokens,
    title,
    body,
    data,
  }: SendPushNotificationArgs): Promise<true | NotificationsServiceError> => {
    const message: MessagingPayload & { notification: NotificationMessagePayload } = {
      // if we set notification, it will appears on both background and quit stage for iOS.
      // if we don't set notification, this will appear for background but not quit stage
      // we may be able to use data only, but this should be implemented first:
      // https://rnfirebase.io/messaging/usage#background-application-state
      notification: { title, body },
      data: data || {},
    }

    const tokens = deviceTokens.filter((token) => token.length === 163)
    if (tokens.length <= 0) {
      logger.info({ message, tokens }, "no token. skipping notification")
      return new InvalidDeviceNotificationsServiceError()
    }

    return wrapAsyncToRunInSpan({
      namespace: "app.notifications",
      fnName: "sendToDevice",
      fn: () => sendToDevice(tokens, message),
    })()
  }

  const sendFilteredNotification = async (args: SendFilteredPushNotificationArgs) => {
    const { notificationSettings, notificationCategory, data, ...sendNotificationArgs } =
      args

    if (
      !shouldSendNotification({
        notificationCategory,
        notificationSettings,
        notificationChannel: NotificationChannel.Push,
      })
    ) {
      return {
        status: SendFilteredPushNotificationStatus.Filtered,
      }
    }

    const result = await sendNotification({
      ...sendNotificationArgs,
      data: {
        ...data,
        NotificationCategory: notificationCategory,
      },
    })

    if (result instanceof NotificationsServiceError) {
      return result
    }

    return {
      status: SendFilteredPushNotificationStatus.Sent,
    }
  }

  return { sendNotification, sendFilteredNotification }
}

export const handleCommonNotificationErrors = (err: Error | string | unknown) => {
  const errMsg = parseErrorMessageFromUnknown(err)

  const match = (knownErrDetail: RegExp): boolean => knownErrDetail.test(errMsg)

  switch (true) {
    case match(KnownNotificationErrorMessages.GoogleBadGatewayError):
    case match(KnownNotificationErrorMessages.GoogleInternalServerError):
      return new NotificationsServiceUnreachableServerError(errMsg)

    default:
      return new UnknownNotificationsServiceError(errMsg)
  }
}

export const KnownNotificationErrorMessages = {
  GoogleBadGatewayError: /Raw server response .* Error 502/,
  GoogleInternalServerError: /Raw server response .* Error 500/,
} as const

export const SendFilteredPushNotificationStatus = {
  Sent: "Sent",
  Filtered: "Filtered",
} as const
