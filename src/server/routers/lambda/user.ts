import { UserJSON } from '@clerk/backend';
import { z } from 'zod';

import { enableClerk } from '@/const/auth';
import { isDesktop } from '@/const/version';
import { MessageModel } from '@/database/models/message';
import { SessionModel } from '@/database/models/session';
import { UserModel, UserNotFoundError } from '@/database/models/user';
import { ClerkAuth } from '@/libs/clerk-auth';
import { pino } from '@/libs/logger';
import { LobeNextAuthDbAdapter } from '@/libs/next-auth/adapter';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import { UserService } from '@/server/services/user';
import {
  NextAuthAccountSchame,
  UserGuideSchema,
  UserInitializationState,
  UserPreference,
} from '@/types/user';
import { UserSettings } from '@/types/user/settings';

const userProcedure = authedProcedure.use(serverDatabase).use(async ({ ctx, next }) => {
  return next({
    ctx: {
      clerkAuth: new ClerkAuth(),
      nextAuthDbAdapter: LobeNextAuthDbAdapter(ctx.serverDB),
      userModel: new UserModel(ctx.serverDB, ctx.userId),
    },
  });
});

export const userRouter = router({
  getUserRegistrationDuration: userProcedure.query(async ({ ctx }) => {
    return ctx.userModel.getUserRegistrationDuration();
  }),

  getUserSSOProviders: userProcedure.query(async ({ ctx }) => {
    return ctx.userModel.getUserSSOProviders();
  }),

  getUserState: userProcedure.query(async ({ ctx }): Promise<UserInitializationState> => {
    let state: Awaited<ReturnType<UserModel['getUserState']>> | undefined;

    // get or create first-time user
    while (!state) {
      try {
        state = await ctx.userModel.getUserState(KeyVaultsGateKeeper.getUserKeyVaults);
      } catch (error) {
        // user not create yet
        if (error instanceof UserNotFoundError) {
          // if in clerk auth mode
          if (enableClerk) {
            const user = await ctx.clerkAuth.getCurrentUser();
            if (user) {
              const userService = new UserService();

              await userService.createUser(user.id, {
                created_at: user.createdAt,
                email_addresses: user.emailAddresses.map((e) => ({
                  email_address: e.emailAddress,
                  id: e.id,
                })),
                first_name: user.firstName,
                id: user.id,
                image_url: user.imageUrl,
                last_name: user.lastName,
                phone_numbers: user.phoneNumbers.map((e) => ({
                  id: e.id,
                  phone_number: e.phoneNumber,
                })),
                primary_email_address_id: user.primaryEmailAddressId,
                primary_phone_number_id: user.primaryPhoneNumberId,
                username: user.username,
              } as UserJSON);

              continue;
            }
          }

          // if in desktop mode, make sure desktop user exist
          else if (isDesktop) {
            await UserModel.makeSureUserExist(ctx.serverDB, ctx.userId);
            pino.info('create desktop user');
            continue;
          }
        }

        console.error('getUserState:', error);
        throw error;
      }
    }

    const messageModel = new MessageModel(ctx.serverDB, ctx.userId);
    const hasMoreThan4Messages = await messageModel.hasMoreThanN(4);

    const sessionModel = new SessionModel(ctx.serverDB, ctx.userId);
    const hasAnyMessages = await messageModel.hasMoreThanN(0);
    const hasExtraSession = await sessionModel.hasMoreThanN(1);

    return {
      canEnablePWAGuide: hasMoreThan4Messages,
      canEnableTrace: hasMoreThan4Messages,
      // 有消息，或者创建过助手，则认为有 conversation
      hasConversation: hasAnyMessages || hasExtraSession,

      // always return true for community version
      isOnboard: state.isOnboarded || true,
      preference: state.preference as UserPreference,
      settings: state.settings,
      userId: ctx.userId,
    };
  }),

  makeUserOnboarded: userProcedure.mutation(async ({ ctx }) => {
    return ctx.userModel.updateUser({ isOnboarded: true });
  }),

  resetSettings: userProcedure.mutation(async ({ ctx }) => {
    return ctx.userModel.deleteSetting();
  }),

  unlinkSSOProvider: userProcedure.input(NextAuthAccountSchame).mutation(async ({ ctx, input }) => {
    const { provider, providerAccountId } = input;
    if (
      ctx.nextAuthDbAdapter?.unlinkAccount &&
      typeof ctx.nextAuthDbAdapter.unlinkAccount === 'function' &&
      ctx.nextAuthDbAdapter?.getAccount &&
      typeof ctx.nextAuthDbAdapter.getAccount === 'function'
    ) {
      const account = await ctx.nextAuthDbAdapter.getAccount(providerAccountId, provider);
      // The userId can either get from ctx.nextAuth?.id or ctx.userId
      if (!account || account.userId !== ctx.userId) throw new Error('The account does not exist');
      await ctx.nextAuthDbAdapter.unlinkAccount({ provider, providerAccountId });
    } else {
      throw new Error('The method in LobeNextAuthDbAdapter `unlinkAccount` is not implemented');
    }
  }),

  updateGuide: userProcedure.input(UserGuideSchema).mutation(async ({ ctx, input }) => {
    return ctx.userModel.updateGuide(input);
  }),

  updatePreference: userProcedure.input(z.any()).mutation(async ({ ctx, input }) => {
    return ctx.userModel.updatePreference(input);
  }),

  updateSettings: userProcedure
    .input(z.object({}).passthrough())
    .mutation(async ({ ctx, input }) => {
      const { keyVaults, ...res } = input as Partial<UserSettings>;

      // Encrypt keyVaults
      let encryptedKeyVaults: string | null = null;

      if (keyVaults) {
        // TODO: better to add a validation
        const data = JSON.stringify(keyVaults);
        const gateKeeper = await KeyVaultsGateKeeper.initWithEnvKey();

        encryptedKeyVaults = await gateKeeper.encrypt(data);
      }

      const nextValue = { ...res, keyVaults: encryptedKeyVaults };

      return ctx.userModel.updateSetting(nextValue);
    }),
});

export type UserRouter = typeof userRouter;
