/** A request generation, rather than an ID alone: redirects may reuse CDP IDs. */
export interface Favicon404Evidence { confirmed: boolean }

interface TrackedFavicon extends Favicon404Evidence {
  url: string;
  expiresAt: number;
}

export interface NetworkLogEntry {
  source?: string;
  level: string;
  text: string;
  url?: string;
  networkRequestId?: string;
}

export interface DiagnosticRequest {
  requestId: string;
  request: { url: string; method: string };
  type?: string;
  initiator?: { type: string };
}

export interface DiagnosticResponse {
  requestId?: string;
  type?: string;
  response: { status: number; url: string };
}

function faviconUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    // Match an asset filename, never a query parameter, API path or partial word.
    const name = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
    return /^favicon(?:-\d+x\d+)?\.(?:ico|png|svg)$/i.test(name);
  } catch { return false; }
}

/** Fail open when CDP cannot prove this is a browser favicon request returning 404. */
export class Favicon404Filter {
  private requests = new Map<string, TrackedFavicon>();

  requestStarted(e: DiagnosticRequest): void {
    // A redirect or a new request invalidates the previous generation immediately.
    this.requests.delete(e.requestId);
    if (e.type !== "Other" || e.initiator?.type !== "other" ||
        e.request.method !== "GET" || !faviconUrl(e.request.url)) return;
    this.requests.set(e.requestId, { url: e.request.url, confirmed: false, expiresAt: Date.now() + 60_000 });
    // Completed requests briefly remain available for a late Log.entryAdded.
    // Both their lifetime and count are bounded; eviction only retains extra errors.
    if (this.requests.size > 128) this.requests.delete(this.requests.keys().next().value!);
  }

  responseReceived(e: DiagnosticResponse): Favicon404Evidence | undefined {
    const request = this.get(e.requestId);
    if (!request) return;
    request.confirmed = e.type === "Other" && e.response.status === 404 && e.response.url === request.url;
    return request.confirmed ? request : undefined;
  }

  logEvidence(entry: NetworkLogEntry): Favicon404Evidence | undefined {
    if (entry.source !== "network" || !entry.url ||
        !/^Failed to load resource: the server responded with a status of 404(?: \([^\r\n]*\))?$/.test(entry.text)) return;
    const request = this.get(entry.networkRequestId);
    return request?.url === entry.url ? request : undefined;
  }

  requestFailed(requestId: string): void { this.requests.delete(requestId); }
  clear(): void { this.requests.clear(); }

  private get(requestId?: string): TrackedFavicon | undefined {
    if (!requestId) return;
    const request = this.requests.get(requestId);
    if (request && Date.now() >= request.expiresAt) {
      this.requests.delete(requestId);
      return;
    }
    return request;
  }
}
