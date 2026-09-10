/** Zustand store for realtime Codex account state. */
import { create } from 'zustand';
import type {
  AccountRateLimitsResponseDto,
  AccountReadResponseDto,
  LoginAccountResponseDto,
  RateLimitSnapshotDto,
} from '@/generated/api/types.gen';
import type {
  AccountLoginCompletedNotification,
  AccountUpdatedNotification,
} from '@/types/account';

type AccountReadResponse = AccountReadResponseDto;
type LoginAccountResponse = LoginAccountResponseDto;
type AccountRateLimitsResponse = AccountRateLimitsResponseDto;
type RateLimitSnapshot = RateLimitSnapshotDto;

interface LoginState {
  inProgress: boolean;
  loginId: string | null;
  method: LoginAccountResponse['type'] | null;
  response: LoginAccountResponse | null;
  lastResult: AccountLoginCompletedNotification | null;
}

interface AccountState {
  account: AccountReadResponse | null;
  authMode: AccountUpdatedNotification['authMode'];
  planType: AccountUpdatedNotification['planType'];
  rateLimits: AccountRateLimitsResponse | null;
  login: LoginState;

  setAccount: (account: AccountReadResponse | null) => void;
  setAccountUpdated: (payload: AccountUpdatedNotification) => void;
  setRateLimits: (rateLimits: AccountRateLimitsResponse | null) => void;
  setRateLimitSnapshot: (snapshot: RateLimitSnapshot) => void;
  setLoginStarted: (response: LoginAccountResponse) => void;
  setLoginCompleted: (payload: AccountLoginCompletedNotification) => void;
  clearLogin: () => void;
}

const emptyLogin: LoginState = {
  inProgress: false,
  loginId: null,
  method: null,
  response: null,
  lastResult: null,
};

function loginIdFromResponse(response: LoginAccountResponse): string | null {
  return 'loginId' in response ? (response.loginId ?? null) : null;
}

export const useAccountStore = create<AccountState>((set, get) => ({
  account: null,
  authMode: null,
  planType: null,
  rateLimits: null,
  login: emptyLogin,

  setAccount: (account) =>
    set({
      account,
      authMode: account?.account?.type === 'chatgpt' ? 'chatgpt' : null,
      planType: account?.account?.type === 'chatgpt' ? account.account.planType : null,
    }),

  setAccountUpdated: (payload) =>
    set({ authMode: payload.authMode, planType: payload.planType }),

  setRateLimits: (rateLimits) => set({ rateLimits }),

  setRateLimitSnapshot: (snapshot) => {
    const existing = get().rateLimits;
    set({
      rateLimits: {
        rateLimits: snapshot,
        rateLimitsByLimitId: existing?.rateLimitsByLimitId ?? null,
        ordinaryUsageAllowed: existing?.ordinaryUsageAllowed ?? null,
      },
    });
  },

  setLoginStarted: (response) =>
    set({
      login: {
        inProgress: response.type === 'chatgpt' || response.type === 'chatgptDeviceCode',
        loginId: loginIdFromResponse(response),
        method: response.type,
        response,
        lastResult: null,
      },
    }),

  setLoginCompleted: (payload) =>
    set((state) => ({
      login: { ...state.login, inProgress: false, lastResult: payload },
    })),

  clearLogin: () => set({ login: emptyLogin }),
}));
