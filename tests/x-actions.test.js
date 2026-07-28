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
      bottom: 145,
      height: 55,
      iconSize: 32,
      right: 36,
      width: 55
    }
  );
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
