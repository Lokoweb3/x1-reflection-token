// node:fs / os / path for the browser build: only reached by server-side code paths (config
// files), which the recovery page never calls.
const no = () => { throw new Error("Not available in the browser"); };
export const existsSync = () => false;
export const readFileSync = no, writeFileSync = no, mkdirSync = no, readdirSync = no, appendFileSync = no, renameSync = no, statSync = no;
export const homedir = () => "";
export const resolve = (...p: string[]) => p.join("/"), join = (...p: string[]) => p.join("/"), dirname = (p: string) => p.replace(/\/[^/]*$/, ""), basename = (p: string) => p.replace(/^.*\//, "");
export default { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, appendFileSync, renameSync, statSync, homedir, resolve, join, dirname, basename };
