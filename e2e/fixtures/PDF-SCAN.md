The `sample-payslip-open.pdf`, `sample-payslip-locked.pdf`, and
`sample-receipt-image-locked.pdf` files contain invented text and figures only.
They contain no real payslip, employer logo, employee identity, or account number.

The two payslip files have the same two pages: dates on the first page and a
summary plus earnings/deductions on the second. The locked payslip and image-only
receipt use AES-256 encryption, with the test password `test1234`.

`node e2e/pdf-scan.mjs` checks them through the real single-document scanner,
including wrong passwords, cancellation, multi-page preview, and image-only OCR.
Serve the repository on port 8124 first, as for `e2e/run.mjs`.
