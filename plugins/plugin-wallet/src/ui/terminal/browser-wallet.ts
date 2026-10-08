/**
 * Phantom as the Real trade tab's browser wallet. Finds the provider Phantom
 * injects (`window.phantom.solana`, or a `window.solana` that says it is
 * Phantom), connects only when the person asks, and signs one reviewed
 * transaction at a time. Phantom shows its own approval popup for every
 * signature, so a trade signed here always rests on the person's approval in
 * the wallet as well as their confirm tap in the terminal.
 *
 * This module never sends a transaction: it returns the signed bytes, and the
 * server's execute route checks they are the reviewed message before sending.
 * Signing uses `signTransaction`, not `signAndSendTransaction`, for that
 * reason. The elizaOS app's own injected wallet (`isEliza`) is not treated as Phantom.
 */
import { VersionedTransaction } from "@solana/web3.js";
import { useCallback, useEffect, useRef, useState } from "react";

interface Base58Key {
  toBase58(): string;
}

/** The part of Phantom's injected Solana provider the terminal uses. */
export interface PhantomProvider {
  isPhantom?: boolean;
  isEliza?: boolean;
  publicKey: Base58Key | null;
  connect(options?: {
    onlyIfTrusted?: boolean;
  }): Promise<{ publicKey: Base58Key }>;
  disconnect(): Promise<void>;
  signTransaction(
    transaction: VersionedTransaction,
  ): Promise<VersionedTransaction>;
  on?(
    event: "accountChanged" | "disconnect",
    handler: (key?: Base58Key | null) => void,
  ): void;
  removeListener?(
    event: "accountChanged" | "disconnect",
    handler: (key?: Base58Key | null) => void,
  ): void;
}

type PhantomWindow = {
  phantom?: { solana?: PhantomProvider };
  solana?: PhantomProvider;
};

function isPhantom(
  provider: PhantomProvider | undefined,
): provider is PhantomProvider {
  return provider?.isPhantom === true && provider.isEliza !== true;
}

/** Phantom's injected provider in this browser, or null when it isn't installed. */
export function findPhantom(): PhantomProvider | null {
  if (typeof window === "undefined") return null;
  const target = window as unknown as PhantomWindow;
  if (isPhantom(target.phantom?.solana)) return target.phantom.solana;
  if (isPhantom(target.solana)) return target.solana;
  return null;
}

export type BrowserWalletState =
  | { status: "missing" }
  | { status: "disconnected"; error: string | null }
  | { status: "connecting" }
  | { status: "connected"; address: string };

export type BrowserSignOutcome =
  | { ok: true; signedTransaction: string }
  | { ok: false; message: string };

export interface BrowserWalletHandle {
  state: BrowserWalletState;
  connect: () => void;
  disconnect: () => void;
  /** Ask Phantom to sign the reviewed transaction for `address`. */
  sign: (
    unsignedBase64: string,
    address: string,
  ) => Promise<BrowserSignOutcome>;
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Phantom rejects with code 4001 when the person declines in its popup. */
function describeWalletError(error: unknown, action: string): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code: unknown }).code
      : null;
  if (code === 4001) return `You declined the ${action} in Phantom.`;
  const message = error instanceof Error ? error.message : String(error);
  return `Phantom couldn't finish the ${action}: ${message}`;
}

/** Phantom connection state plus connect, disconnect, and sign for the Real trade tab. */
export function usePhantomWallet(): BrowserWalletHandle {
  const [provider] = useState(findPhantom);
  const [state, setState] = useState<BrowserWalletState>(() =>
    provider === null
      ? { status: "missing" }
      : provider.publicKey
        ? { status: "connected", address: provider.publicKey.toBase58() }
        : { status: "disconnected", error: null },
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!provider?.on) return;
    const onAccount = (key?: Base58Key | null) => {
      setState(
        key
          ? { status: "connected", address: key.toBase58() }
          : { status: "disconnected", error: null },
      );
    };
    const onDisconnect = () =>
      setState({ status: "disconnected", error: null });
    provider.on("accountChanged", onAccount);
    provider.on("disconnect", onDisconnect);
    return () => {
      provider.removeListener?.("accountChanged", onAccount);
      provider.removeListener?.("disconnect", onDisconnect);
    };
  }, [provider]);

  const connect = useCallback(() => {
    if (!provider) return;
    setState({ status: "connecting" });
    provider.connect().then(
      ({ publicKey }) => {
        if (mounted.current) {
          setState({ status: "connected", address: publicKey.toBase58() });
        }
      },
      (error: unknown) => {
        // error-policy:J4 a declined or failed connect is shown on the tab.
        if (mounted.current) {
          setState({
            status: "disconnected",
            error: describeWalletError(error, "connection"),
          });
        }
      },
    );
  }, [provider]);

  const disconnect = useCallback(() => {
    if (!provider) return;
    setState({ status: "disconnected", error: null });
    provider.disconnect().catch((error: unknown) => {
      // error-policy:J4 the terminal forgot the account; say Phantom didn't confirm.
      if (mounted.current) {
        setState({
          status: "disconnected",
          error: describeWalletError(error, "disconnect"),
        });
      }
    });
  }, [provider]);

  const sign = useCallback(
    async (
      unsignedBase64: string,
      address: string,
    ): Promise<BrowserSignOutcome> => {
      if (!provider) {
        return {
          ok: false,
          message: "Phantom isn't installed in this browser.",
        };
      }
      const current = provider.publicKey?.toBase58() ?? null;
      if (current !== address) {
        return {
          ok: false,
          message:
            "Phantom is on a different account than this review. Review the trade again.",
        };
      }
      try {
        const signed = await provider.signTransaction(
          VersionedTransaction.deserialize(fromBase64(unsignedBase64)),
        );
        return { ok: true, signedTransaction: toBase64(signed.serialize()) };
      } catch (error) {
        // error-policy:J4 a declined or failed signature is shown in the review.
        return { ok: false, message: describeWalletError(error, "signature") };
      }
    },
    [provider],
  );

  return { state, connect, disconnect, sign };
}
