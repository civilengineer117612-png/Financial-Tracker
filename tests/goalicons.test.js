import { test } from "node:test";
import assert from "node:assert/strict";
import { GOAL_SYMBOLS, goalSymbolSvg, setGoalSymbol, setGoalIcon, validateShape } from "../src/model/index.js";
import { makeState } from "./fixtures.js";

const withGoal = (extra = {}) => ({ ...makeState(), goals: [{ id: "g1", name: "Test Goal", hidden_by_default: false, ...extra }] });
const PNG = "data:image/png;base64,iVBORw0KGgo=";

test("eight pictures with their own ids and names, each drawn in the ink colour with no colour of its own", () => {
  assert.equal(GOAL_SYMBOLS.length, 8);
  assert.equal(new Set(GOAL_SYMBOLS.map((x) => x.id)).size, 8);
  for (const x of GOAL_SYMBOLS) {
    const svg = goalSymbolSvg(x.id, 26);
    assert.ok(x.label && svg.includes('stroke="currentColor"') && svg.includes('width="26"') && !/#[0-9a-f]{3}|rgb\(/i.test(svg), x.id);
    assert.ok(svg.includes("<path"), x.id);
  }
  assert.equal(goalSymbolSvg("nope"), null, "an unknown id has no picture, the letter shows instead");
});
test("choosing a picture is kept on the goal, replaces a photo chosen before, and a goal without one stays valid", () => {
  const s = withGoal({ icon: PNG });
  const r = setGoalSymbol(s, "g1", "house");
  assert.ok(r.ok);
  assert.equal(r.state.goals[0].symbol, "house");
  assert.equal(r.state.goals[0].icon, undefined, "the latest choice is the one shown");
  assert.deepEqual(validateShape("Goal", r.state.goals[0]), []);
  assert.deepEqual(validateShape("Goal", withGoal().goals[0]), [], "absent is valid");
});
test("null takes it away; an unknown picture or goal is refused; nothing else on the goal changes", () => {
  const s = withGoal({ target: 500000, share_bps: 5000, symbol: "car" });
  const cleared = setGoalSymbol(s, "g1", null);
  assert.equal(cleared.state.goals[0].symbol, undefined);
  assert.equal(cleared.state.goals[0].target, 500000);
  assert.equal(cleared.state.goals[0].share_bps, 5000);
  assert.equal(setGoalSymbol(s, "g1", "unicorn").ok, false);
  assert.equal(setGoalSymbol(s, "zzz", "house").ok, false);
  assert.equal(s.goals[0].symbol, "car", "the original state is untouched");
});
test("a photo chosen after a picture still works", () => {
  const r = setGoalIcon(withGoal({ symbol: "gift" }), "g1", PNG);
  assert.ok(r.ok && r.state.goals[0].icon === PNG);
});
