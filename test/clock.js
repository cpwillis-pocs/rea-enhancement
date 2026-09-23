'use strict';
// Freeze Date for unit tests so fixture dates ("12 Oct 2026", "Available now") mean the
// same thing whatever day CI runs. Timers are left real (fetch tests use setTimeout).
const { mock } = require('node:test');
const NOW = new Date(2026, 8, 23, 10, 0, 0); // 23 Sep 2026 10:00 local
mock.timers.enable({ apis: ['Date'], now: NOW });
module.exports = { NOW };
