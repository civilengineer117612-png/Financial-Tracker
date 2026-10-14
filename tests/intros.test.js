import { test } from "node:test";
import assert from "node:assert/strict";
import { INTROS, MAX_INTRO_SHOWS, introFor, shouldShowIntro, markIntro, introDrawing, STRIP_NAMES } from "../src/model/index.js";

test("an intro uses the screen's own name and two short plain lines", () => {
  const i = introFor("plan");
  assert.equal(i.title, STRIP_NAMES.plan);
  assert.equal(i.lines.length, 2); assert.ok(i.lines.every((l) => l.length < 60 && /\.$/.test(l)));
  assert.equal(introFor("nothing"), null);
});

test("it shows until the check is ticked, but never more than three times", () => {
  let st = {};
  assert.equal(shouldShowIntro(st, "plan"), true);
  for (let n = 1; n < MAX_INTRO_SHOWS; n++) { st = markIntro(st, "plan"); assert.equal(shouldShowIntro(st, "plan"), true, "shown " + n + " time(s): still comes back"); }
  st = markIntro(st, "plan"); assert.equal(shouldShowIntro(st, "plan"), false, "after three showings it stops by itself");
  const off = markIntro({}, "plan", true);
  assert.equal(shouldShowIntro(off, "plan"), false, "ticked: never again");
  assert.deepEqual(off.intro_off, { plan: true });
  assert.equal(shouldShowIntro({}, "no-such-screen"), false, "a screen with no intro shows nothing");
});

test("marking one screen leaves the other settings and the other screens alone", () => {
  const st = markIntro({ keep: 1, intro_seen: { other: 2 } }, "plan");
  assert.equal(st.keep, 1); assert.deepEqual(st.intro_seen, { other: 2, plan: 1 });
});

test("the drawing is pure SVG in theme colours only, with the bars numbered for the animation, and no red", () => {
  const svg = introDrawing(INTROS.plan.drawing);
  assert.match(svg, /^<svg/); assert.ok((svg.match(/class="in-bar"/g) ?? []).length >= 3);
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(svg) && !/red/i.test(svg), "only var(--…) colours");
  assert.equal(introDrawing("unknown"), "");
});
