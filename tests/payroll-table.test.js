import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pdfScanText, readPayslip } from '../src/model/scan.js';
import { payrollItems } from '../e2e/payroll-table.mjs';
const read = (opts) => readPayslip(pdfScanText(payrollItems(opts)), '2026-10-23', {allowHistorical:true});
const sum = (a) => a.reduce((s,l)=>s+l.amount,0);
test('blank summary cell stays zero and all earnings reconcile',()=>{
  const r=read(); assert.equal(r.error,undefined); assert.equal(sum(r.earnings),1700000);
  assert.equal(r.printed_gross,1700000);assert.equal(r.printed_net,1520000);assert.equal(r.printed_deductions,180000);
});
test('explicit zero after-tax summary is equivalent to blank',()=>{
  const r=read({blank:false});assert.equal(r.printed_deductions,180000);assert.equal(sum(r.earnings),1700000);
});
test('side by side sections survive reversed content-stream order',()=>{
  const r=read({reverse:true}); assert.equal(sum(r.earnings),1700000);assert.equal(sum(r.deductions),180000);
  assert.deepEqual(r,read());
});
test('YTD and accrual figures never contribute to this period',()=>{
  const r=read();assert.equal(sum(r.earnings),1700000);assert.deepEqual(r,read({ytd:false}));
});
test('zero and changed hours do not replace money',()=>{
  const r=read({hours:'999.00'});assert.equal(sum(r.earnings),1700000);assert.equal(r.earnings.find(l=>l.kind==='other').amount,250000);
});
test('retro and non-taxable lines count without changing saved categories',()=>{
  const r=read();assert.equal(r.earnings.find(l=>l.kind==='other')?.amount,250000);
  assert.equal(r.earnings.find(l=>l.kind==='basic')?.amount,1200000);
  assert.equal(r.earnings.find(l=>l.kind==='overtime')?.amount,250000);
});
test('all three deduction sections reconcile independently',()=>{
  const r=read({after:true});assert.equal(r.printed_deductions,200000);assert.equal(sum(r.deductions),200000);
  assert.equal(r.printed_net,1500000);assert.equal(r.deposit,1500000);
});
test('distribution is read independently and employer/date labels stay separate',()=>{
  const r=read();assert.equal(r.deposit,1520000);assert.equal(r.employer,'Example Employer Ltd');
  assert.equal(r.pay_date,'2026-01-16');assert.equal(r.period_from,'2026-01-01');assert.equal(r.period_to,'2026-01-15');
});
for(const [label,change] of [
  ['gross',a=>{a.find(i=>i.y===640&&i.str==='17,000.00').str='18,000.00';}],
  ['deduction section',a=>{a.find(i=>i.y===640&&i.str==='1,200.00').str='1,100.00';a.find(i=>i.y===640&&i.str==='600.00').str='700.00';}],
  ['net',a=>{for(const i of a.filter(i=>i.str==='15,200.00'))i.str='15,300.00';}],
  ['distribution',a=>{a.find(i=>i.y===345&&i.str==='15,200.00').str='15,100.00';}],
  ['malformed amount',a=>{a.find(i=>i.str==='12,000.00').str='12,OOO.OO';}],
  ['missing section',a=>{a.find(i=>i.str==='Tax Deductions').str='Unclear heading';}],
]) test(`reader refuses ${label} with a plain message and no guessed lines`,()=>{
  const r=read({change});assert.match(r.error??'',/could not|do not|does not/i);assert.deepEqual(r.earnings,[]);assert.deepEqual(r.deductions,[]);
});
