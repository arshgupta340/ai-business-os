// @vitest-environment jsdom
import {afterEach, describe, expect, it} from 'vitest';
import {MOCK_SESSION_STORAGE_KEY, readMockSession} from './auth/mock-session';
import {DEMO_OWNER} from './auth/owner';
import {BUSINESS_STORAGE_KEY} from './business-selection';
import {clearOwnerStorage} from './owner-storage';
import {SIGN_IN_NOTICE_STORAGE_KEY} from './session-notice';

afterEach(() => {
  window.localStorage.clear();
});

describe('clearOwnerStorage', () => {
  it('removes the selected business and the builder memory and keeps the rest', () => {
    const storage = window.localStorage;
    storage.setItem(BUSINESS_STORAGE_KEY, 'biz_pizza_01');
    storage.setItem('abos.builderSessions', '{"biz_pizza_01":"bld_1"}');
    storage.setItem('abos.builderNotes.bld_1', '{}');
    storage.setItem('abos.builderNotes.bld_2', '{}');
    storage.setItem(MOCK_SESSION_STORAGE_KEY, JSON.stringify({owner: DEMO_OWNER}));
    storage.setItem(SIGN_IN_NOTICE_STORAGE_KEY, 'notice');

    clearOwnerStorage(storage);

    expect(storage.getItem(BUSINESS_STORAGE_KEY)).toBeNull();
    expect(storage.getItem('abos.builderSessions')).toBeNull();
    expect(storage.getItem('abos.builderNotes.bld_1')).toBeNull();
    expect(storage.getItem('abos.builderNotes.bld_2')).toBeNull();
    expect(storage.getItem(MOCK_SESSION_STORAGE_KEY)).not.toBeNull();
    expect(storage.getItem(SIGN_IN_NOTICE_STORAGE_KEY)).toBe('notice');
  });

  it('does nothing without storage', () => {
    expect(() => clearOwnerStorage(null)).not.toThrow();
  });
});

describe('readMockSession', () => {
  it('gives a session stored without an id the demo owner id', () => {
    window.localStorage.setItem(MOCK_SESSION_STORAGE_KEY, JSON.stringify({owner: {email: 'owner@demo.test', displayName: 'Demo owner'}}));
    expect(readMockSession(window.localStorage)?.id).toBe(DEMO_OWNER.id);
  });
});
