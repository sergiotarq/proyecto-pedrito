"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { getTimeoutResult } = require("../game-rules");

test("a tied match enters sudden death when time expires", () => {
  assert.deepEqual(getTimeoutResult([3, 3]), { type: "overtime" });
});

test("the player with the higher score wins when time expires", () => {
  assert.deepEqual(getTimeoutResult([4, 2]), { type: "winner", winner: 1 });
  assert.deepEqual(getTimeoutResult([1, 3]), { type: "winner", winner: 2 });
});
