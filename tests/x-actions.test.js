const test = require("node:test");
const assert = require("node:assert/strict");
const Actions = require("../src/shared/core.js");

test("user cells route mute through a temporary profile tab", () => {
  assert.equal(Actions.muteExecutionMode("cell"), "profile-tab");
  assert.equal(Actions.muteExecutionMode("tweet"), "inline-menu");
  assert.equal(Actions.muteExecutionMode("profile"), "inline-menu");
});

test("mute buttons are not offered for the signed-in account", () => {
  assert.equal(Actions.shouldOfferMute("timerringX", "@timerringx"), false);
  assert.equal(Actions.shouldOfferMute("timerringX", "@someone_else"), true);
});

test("profile actions never fall back to a tweet caret", () => {
  const profileMenu = {};
  const root = {
    querySelector(selector) {
      if (selector === '[data-testid="userActions"]') return profileMenu;
      if (selector === 'button[data-testid="caret"]') return {};
      return null;
    }
  };

  assert.equal(Actions.findMenuButton(root, true), profileMenu);
});

test("tweet actions use the caret inside their scoped root", () => {
  const caret = {};
  const root = {
    querySelector(selector) {
      return selector === 'button[data-testid="caret"]' ? caret : null;
    }
  };

  assert.equal(Actions.findMenuButton(root, false), caret);
});

test("mute action supports X menu items without data-testid", () => {
  const muteItem = {
    textContent: "Mute",
    getAttribute() {
      return null;
    }
  };
  const menu = {
    querySelectorAll(selector) {
      return selector === '[role="menuitem"]' ? [muteItem] : [];
    }
  };
  const root = {
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      return selector === '[role="menu"]' ? [menu] : [];
    }
  };

  assert.deepEqual(Actions.findMuteMenuItem(root), {
    element: muteItem,
    alreadyDone: false
  });
});
