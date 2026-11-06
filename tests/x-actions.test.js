const test = require("node:test");
const assert = require("node:assert/strict");
const Actions = require("../src/shared/core.js");

test("mute request parameters prefer a numeric user ID", () => {
  assert.equal(Actions.extractUserId("4398626122-follow"), "4398626122");
  assert.equal(Actions.extractUserId("4398626122-unfollow"), "4398626122");
  assert.equal(Actions.makeMuteRequestBody("@OpenAI", "4398626122"), "user_id=4398626122");
  assert.equal(Actions.makeMuteRequestBody("@OpenAI", ""), "screen_name=openai");
});

test("mute buttons are not offered for the signed-in account", () => {
  assert.equal(Actions.shouldOfferMute("timerringX", "@timerringx"), false);
  assert.equal(Actions.shouldOfferMute("timerringX", "@someone_else"), true);
});

test("csrf token is read from the X cookie string", () => {
  assert.equal(Actions.readCookie("guest_id=abc; ct0=csrf%20token; lang=en", "ct0"), "csrf token");
  assert.equal(Actions.readCookie("guest_id=abc", "ct0"), "");
});

test("page shortcut aligns above the native floating-button stack", () => {
  assert.deepEqual(
    Actions.shortcutGeometry(
      { left: 2742, right: 2797, top: 1333, bottom: 1388, width: 55, height: 55 },
      { width: 2833, height: 1466 },
      12
    ),
    {
      left: 2742,
      top: 1266,
      height: 55,
      iconSize: 32,
      width: 55
    }
  );
});

test("shortcut follows fractional native coordinates across viewport sizes and scrollbar widths", () => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1080 },
    { width: 800, height: 1200 }
  ]) {
    for (const scrollbar of [0, 15]) {
      const anchor = {
        left: viewport.width - scrollbar - 70.5,
        right: viewport.width - scrollbar - 15.25,
        top: viewport.height - 150.75,
        width: 55.25,
        height: 55.25
      };
      const geometry = Actions.shortcutGeometry(anchor, viewport);
      assert.equal(geometry.left, anchor.left);
      assert.equal(geometry.width, anchor.width);
      assert.equal(geometry.height, anchor.height);
      assert.equal(geometry.top + geometry.height + 12, anchor.top);
    }
  }
});

test("the topmost visible native button anchors the shortcut stack", () => {
  assert.deepEqual(
    Actions.topmostRect([
      { top: 1400, bottom: 1455, width: 55, height: 55 },
      { top: 1333, bottom: 1388, width: 55, height: 55 }
    ]),
    { top: 1333, bottom: 1388, width: 55, height: 55 }
  );
});

test("shortcut coordinates use the page's effective CSS scale", () => {
  for (const scale of [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3]) {
    const geometry = Actions.shortcutGeometry(
      { left: 210 * scale, top: 250 * scale, width: 55 * scale, height: 55 * scale },
      { width: 1000, height: 1000, scale }
    );
    assert.ok(Math.abs(geometry.left - 210) < 1e-8);
    assert.ok(Math.abs(geometry.top - 183) < 1e-8);
    assert.ok(Math.abs(geometry.width - 55) < 1e-8);
  }
});

test("short viewports place the shortcut alongside the native control", () => {
  const viewport = { width: 320, height: 180 };
  const leftSide = Actions.shortcutGeometry({ left: 240, top: 30, width: 55, height: 55 }, viewport);
  assert.equal(leftSide.left, 173);
  assert.equal(leftSide.top, 30);
  const rightSide = Actions.shortcutGeometry({ left: 10, top: 30, width: 55, height: 55 }, viewport);
  assert.equal(rightSide.left, 77);
  assert.equal(rightSide.top, 30);
  assert.equal(Actions.shortcutGeometry({ left: 10, top: 10, width: 55, height: 55 }, { width: 70, height: 70 }), null);
});
