// Entirely invented payroll data. Generate a text PDF in memory; no payslip file is kept.
export function payrollItems({ blank = true, hours = '64.00', ytd = true, after = false, change = null, reverse = false } = {}) {
  const a = [], put = (str, x, y) => a.push({ str, x, y, w: str.length * 5, h: 8.333333333 });
  const right = (str, x, y) => put(str, x - str.length * 5, y);
  put('Payslip', 260, 815);
  put('Employee Full Name', 25, 775); put('Example Person', 125, 775);
  put('Employer Name', 310, 775); put('Example Employer Ltd', 400, 775);
  put('Pay Basis', 310, 760); put('Monthly Non Exempt', 400, 760);
  ['Pay Period','Payment Date','Pay Begin Date','Pay End Date','Pay Rate','Annual Salary'].forEach((s,i) => right(s, [90,185,280,375,465,570][i], 710));
  ['Bi-Week','16-Jan-2026','01-Jan-2026','15-Jan-2026','34,000.00','408,000.00'].forEach((s,i) => right(s, [90,185,280,375,465,570][i], 695));
  put('Summary', 25, 670);
  ['Gross','Pre-Tax','Taxes','Deductions','Net Pay'].forEach((s,i) => right(s,[180,275,370,465,570][i],655));
  put('Current',25,640);
  ['17,000.00','1,200.00','600.00',after?'200.00':blank?'':'0.00',after?'15,000.00':'15,200.00'].forEach((s,i)=>{if(s)right(s,[180,275,370,465,570][i],640);});
  put('Hours and Earnings',25,610); put('Pre-Tax Deductions',310,610);
  put('Description',25,595); right('Hours',205,595); right('Amount',290,595);
  put('Description',310,595); right('Amount',570,595);
  [['Regular',hours,'12,000.00'],['Allowance Non Taxable','0.00','1,500.00'],['Overtime','8.00','2,500.00'],['Retro Regular','8.00','1,000.00']].forEach(([s,h,v],i)=>{put(s,25,580-i*15);right(h,205,580-i*15);right(v,290,580-i*15);});
  [['HDMF','100.00'],['PhilHealth','400.00'],['SSS','700.00']].forEach(([s,v],i)=>{put(s,310,580-i*15);right(v,570,580-i*15);});
  put('Tax Deductions',310,525); put('Description',310,510); right('Amount',570,510);
  put('Tax Deduction',310,495); right('600.00',570,495);
  put('After Tax Deductions',310,475); put('Description',310,460); right('Amount',570,460);
  if(after){put('Other Deduction',310,445);right('200.00',570,445);}
  put('Accruals',25,415); put('Absences',310,415);
  put('PTO',25,400);right('40.00',205,400);right('99.00',290,400);
  put('Net Pay Distribution',25,375);
  put('Deposit/Cheque',25,360);put('Bank Name',130,360);put('Account Type',235,360);right('Amount',570,360);
  put('Direct Deposit',25,345);put('Example Bank',130,345);put('SA',235,345);right(after?'15,000.00':'15,200.00',570,345);
  if(ytd){put('Other Information',25,315);put('Description',25,300);right('Value',570,300);
    [['Non Taxable Earnings YTD','1,500.00'],['Pre Tax Deductions YTD','1,200.00'],['Tax Deductions YTD','600.00'],['Total Earnings YTD','17,000.00']].forEach(([s,v],i)=>{put(s,25,285-i*15);right(v,570,285-i*15);});}
  if(change) change(a);
  return reverse ? a.reverse() : a;
}

export function payrollPdf(items = payrollItems()) {
  const escape = (s) => s.replace(/[\\()]/g, '\\$&');
  const stream = items.map(i => `BT /F1 8.333333333 Tf 1 0 0 1 ${i.x} ${i.y} Tm (${escape(i.str)}) Tj ET`).join('\n');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n', offsets = [0];
  objects.forEach((o,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${o}\nendobj\n`;});
  const start = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf,'ascii');
}
