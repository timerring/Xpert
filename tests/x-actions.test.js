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
