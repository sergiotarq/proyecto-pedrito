"use strict";

function getTimeoutResult(scores) {
  if (scores[0] === scores[1]) {
    return { type: "overtime" };
  }
  return {
    type: "winner",
    winner: scores[0] > scores[1] ? 1 : 2,
  };
}

module.exports = { getTimeoutResult };
