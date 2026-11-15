/**
 * Which of the three stage shops the demo run is for, and its phone number.
 *
 * The shop data is one shared file, @abos/contracts/fixtures (demo-stage.ts).
 * Nothing about a shop is typed here.
 */
import {DEMO_PHONE_NUMBER, STAGE_SHOPS, stageShopForFileName, type StageShop, type StageShopKey} from '@abos/contracts/fixtures';
import {getDemoPhoneNumberFor, isMockMode} from '@/lib/env';

/** The shop the attached files select: the first file whose name is one of a shop's two files. */
export function shopForFileNames(fileNames: readonly string[]): StageShop | undefined {
  for (const name of fileNames) {
    const shop = stageShopForFileName(name);
    if (shop) return shop;
  }
  return undefined;
}

export function stageShop(key: StageShopKey): StageShop {
  return STAGE_SHOPS[key];
}

/**
 * The number the panel shows for one shop, fixed before the demo. In mock mode
 * with no value, the shared fixture number, so rehearsal works. Otherwise
 * undefined: the panel never invents a number.
 */
export function demoPhoneNumberFor(key: StageShopKey): string | undefined {
  return getDemoPhoneNumberFor(key) ?? (isMockMode() ? DEMO_PHONE_NUMBER : undefined);
}

/** The build-time setting that holds each shop's number, for the "not set" line. */
export const PHONE_SETTING: Record<StageShopKey, string> = {
  pizza: 'NEXT_PUBLIC_DEMO_PHONE_PIZZA',
  barber: 'NEXT_PUBLIC_DEMO_PHONE_BARBER',
  salon: 'NEXT_PUBLIC_DEMO_PHONE_SALON',
};

export function missingNumberText(key: StageShopKey): string {
  return `The phone number of this shop is not set. Set ${PHONE_SETTING[key]} and build the app again.`;
}

/** Shown under the picker while no attached file selects a shop. */
export const NO_SHOP_TEXT = 'Pick a business above, or attach its two files, to use the suggested prompt.';

/** Shown when the chosen shop is not one of the owner's businesses. The steps do not start. */
export function shopNotFoundText(shop: StageShop): string {
  return `${shop.name} is not one of your businesses, so the build cannot start. Set it up on the server first.`;
}
