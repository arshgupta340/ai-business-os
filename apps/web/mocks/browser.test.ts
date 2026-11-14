import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// msw/browser only loads in a browser. waitForControl does not use it.
vi.mock("msw/browser", () => ({ setupWorker: vi.fn() }));

const { waitForControl } = await import("./browser");

/** A stand-in for navigator.serviceWorker: a controller slot and controllerchange listeners. */
function fakeContainer(controller: object | null = null) {
  const target = new EventTarget();
  const source = {
    controller: controller as ServiceWorker | null,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
  const takeControl = () => {
    source.controller = {} as ServiceWorker;
    target.dispatchEvent(new Event("controllerchange"));
  };
  return { source, takeControl };
}

describe("waitForControl", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves true at once when the page is already controlled", async () => {
    const { source } = fakeContainer({});
    await expect(waitForControl(source, 3000)).resolves.toBe(true);
  });

  it("waits for controllerchange when the page is not controlled yet", async () => {
    const { source, takeControl } = fakeContainer();
    let result: boolean | undefined;
    void waitForControl(source, 3000).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(1000);
    expect(result).toBeUndefined();
    takeControl();
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBe(true);
  });

  it("resolves false after the timeout when nothing takes control, so the in-page mock is used", async () => {
    const { source } = fakeContainer();
    let result: boolean | undefined;
    void waitForControl(source, 3000).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(2999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe(false);
  });

  it("stops listening once it has resolved", async () => {
    const { source, takeControl } = fakeContainer();
    const remove = vi.spyOn(source, "removeEventListener");
    const pending = waitForControl(source, 3000);
    takeControl();
    await expect(pending).resolves.toBe(true);
    expect(remove).toHaveBeenCalledWith("controllerchange", expect.any(Function));
  });
});
