// Loaded into the test server only. SIGUSR2 moves its clock 31 s on, past the 30 s view caches.
const real = Date.now.bind(Date);
let offset = 0;
Date.now = () => real() + offset;
process.on("SIGUSR2", () => { offset += 31_000; });
// And it doesn't outlive a test run that was killed.
const parent = process.ppid;
setInterval(() => { if (process.ppid !== parent) process.exit(1); }, 1_000).unref();
