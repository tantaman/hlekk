import React, { useEffect, useRef, useState } from "react";
import { NotebookClient } from "./client";

const messages = {
  denied: "This notebook belongs to a different GitHub account.",
  expired: "The sign-in link expired. Start again to open your notebook.",
  cancelled: "GitHub sign-in was cancelled.",
  failed: "Folio could not finish signing in with GitHub. Please try again.",
};

function forgetThoughtDrafts() {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith("folio:thought:")) sessionStorage.removeItem(key);
    }
  } catch {}
}

export function SessionGate({ children }) {
  const [session, setSession] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const active = useRef(null);

  useEffect(() => {
    let generation = 0;
    let hosted = false;
    let timer;
    function lock() {
      generation++;
      clearTimeout(timer);
      const resume = Boolean(active.current?.client.drafts.size);
      if (!resume) active.current = null;
      setSession({ mode: "github", client: null, resume });
      setError("");
    }
    async function check() {
      const request = ++generation;
      try {
        const response = await fetch("/api/session", { cache: "no-store" });
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (request !== generation) return;
        if (data.mode !== "github" && data.mode !== "local") throw new Error();
        hosted = data.mode === "github";
        if (hosted && !data.owner) return lock();
        clearTimeout(timer);
        if (hosted) timer = setTimeout(lock, data.validFor);
        const current = active.current;
        const sameAccount = current?.mode === data.mode && current.owner?.id === data.owner?.id;
        const client = sameAccount ? current.client : new NotebookClient(undefined, data.owner?.id);
        active.current = { ...data, client };
        setSession(active.current);
        setError("");
      } catch {
        if (request === generation) setError("Could not verify your notebook session.");
      }
    }
    function checkVisible() {
      if (hosted && !document.hidden) check();
    }
    function signoutElsewhere(event) {
      if (event.key === "folio:signout" && event.newValue && hosted) {
        forgetThoughtDrafts();
        active.current = null;
        lock();
      }
    }
    function restored(event) {
      if (hosted && event.persisted) {
        setSession(null);
        check();
      }
    }
    check();
    window.addEventListener("folio:unauthorized", lock);
    window.addEventListener("storage", signoutElsewhere);
    window.addEventListener("pageshow", restored);
    document.addEventListener("visibilitychange", checkVisible);
    return () => {
      generation++;
      clearTimeout(timer);
      window.removeEventListener("folio:unauthorized", lock);
      window.removeEventListener("storage", signoutElsewhere);
      window.removeEventListener("pageshow", restored);
      document.removeEventListener("visibilitychange", checkVisible);
    };
  }, [attempt]);

  async function signOut() {
    const { client } = session;
    try {
      await client.flush();
      const response = await fetch("/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Could not sign out. Please try again.");
    } catch (e) {
      client.emit({ error: e.message });
      return;
    }
    try {
      localStorage.setItem("folio:signout", String(Date.now()));
    } catch {}
    forgetThoughtDrafts();
    active.current = null;
    window.dispatchEvent(new Event("folio:unauthorized"));
    await client.cache?.clear().catch(() => {});
  }

  if (session?.client) return children({ ...session, signOut });
  const params = new URLSearchParams(window.location.search);
  const issue = messages[params.get("signin")];
  let message = typeof issue === "string" ? issue : "Sign in to your personal notebook.";
  if (session?.resume) message = "Your edits are still in this tab. Sign in, then return here to save them.";
  params.delete("signin");
  return (
    <main className="loading login-screen">
      <img src="/mark.svg" width="50" height="50" alt="" />
      <h1>Folio</h1>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <button className="button" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </button>
        </>
      ) : session ? (
        <>
          <p>{message}</p>
          <a
            className="button primary"
            target={session.resume ? "_blank" : undefined}
            rel="noopener"
            href={"/auth/github" + (params.size ? "?" + params : "")}
          >
            Continue with GitHub
          </a>
        </>
      ) : (
        <p>Opening notebook…</p>
      )}
    </main>
  );
}
