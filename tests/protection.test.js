import { test } from "node:test";
import assert from "node:assert/strict";
import { requestStorageProtection, storageProtected } from "../app/protection.js";

test("a granted request reports the browser's true result", async () => {
  assert.equal(await requestStorageProtection({claim:async()=>true,storage:{persist:async()=>true}}),true);
});
test("a refused request reports false, never protection", async () => {
  assert.equal(await requestStorageProtection({claim:async()=>true,storage:{persist:async()=>false}}),false);
});
test("a missing persistence API makes no request or claim", async () => {
  let claims=0;assert.equal(await requestStorageProtection({storage:{},claim:async()=>{claims++;return true;}}),false);
  assert.equal(claims,0);
});
test("repeated and concurrent saves request once after the durable claim", async () => {
  let claimed=false,calls=0;
  const options={claim:async()=>{if(claimed)return false;claimed=true;return true;},storage:{persist:async()=>{assert.equal(claimed,true);calls++;return false;},persisted:async()=>false}};
  await Promise.all([requestStorageProtection(options),requestStorageProtection(options)]);
  await requestStorageProtection(options);assert.equal(calls,1);
});
test("permission errors do not reject or claim protection", async () => {
  assert.equal(await requestStorageProtection({claim:async()=>true,storage:{persist:async()=>{throw new Error('example denial');}}}),false);
});
test("an unavailable durable marker does not prompt repeatedly", async () => {
  let calls=0;assert.equal(await requestStorageProtection({claim:async()=>{throw new Error('example storage failure');},storage:{persist:async()=>{calls++;return true;}}}),false);
  assert.equal(calls,0);
});
test("Setup reads fresh browser status and accepts only an explicit true", async () => {
  let value=true;const storage={persisted:async()=>value};assert.equal(await storageProtected(storage),true);
  value=false;assert.equal(await storageProtected(storage),false);
  value='true';assert.equal(await storageProtected(storage),false);
  assert.equal(await storageProtected({}),false);
  assert.equal(await storageProtected({persisted:async()=>{throw new Error('example failure');}}),false);
});
