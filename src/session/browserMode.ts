export function isHeadlessShell(executable: string): boolean {
  return /(?:^|[\\/])(?:chrome-headless-shell|headless_shell)(?:\.exe)?$/i.test(executable);
}
/** 只识别完整开关；引号或转义不完整时不猜测浏览器模式。 */
export function headlessFromCommandLine(commandLine: string): boolean | undefined {
  const args: string[] = [];
  let value = "", quote = "", started = false;
  for (let i = 0; i < commandLine.length; i++) {
    const char = commandLine[i];
    if (char === "\\" && quote !== "'") {
      let count = 1;
      while (commandLine[i + count] === "\\") count++;
      if (commandLine[i + count] === '"') {
        value += "\\".repeat(Math.floor(count / 2));
        if (count % 2) value += '"';
        else quote = quote ? "" : '"';
        started = true; i += count; continue;
      }
    }
    if (char === '"' || char === "'") {
      if (!quote) quote = char;
      else if (quote === char) quote = "";
      else value += char;
      started = true;
    } else if (!quote && /\s/.test(char)) {
      if (started) args.push(value);
      value = ""; started = false;
    } else { value += char; started = true; }
  }
  if (quote) return undefined;
  if (started) args.push(value);
  if (!args[0]) return undefined;
  return isHeadlessShell(args[0]) || args.slice(1).some(arg => arg === "--headless" || arg.startsWith("--headless="));
}
