/**
 * The crypto terminal's PIN lock surfaces: the lock screen shown in place of
 * the terminal, and the header controls with the set / change / remove PIN
 * dialog. State and hashing live in `usePinLock` and `pin-lock.ts`.
 *
 * The lock screen reveals only how many price alerts fired, never which. Its
 * "Forgot PIN" path erases the PIN together with every saved terminal record
 * in this browser, so a forgotten PIN never unlocks someone else's data. The
 * real wallet and its keys are outside the terminal and untouched.
 */
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  SegmentedControl,
} from "@elizaos/ui";
import { KeyRound, Lock } from "lucide-react";
import * as React from "react";
import { useId, useState } from "react";
import {
  AUTO_LOCK_CHOICES,
  type AutoLockMinutes,
  DEFAULT_AUTO_LOCK_MINUTES,
  isValidPin,
} from "./pin-lock.ts";
import type { PinLockHandle, PinLockOutcome } from "./terminal-data.ts";

void React;

const AUTO_LOCK_ITEMS = AUTO_LOCK_CHOICES.map((minutes) => ({
  value: `${minutes}`,
  label: `${minutes} min`,
}));

/** User-facing copy for every outcome except success. */
export function describePinOutcome(outcome: PinLockOutcome): string | null {
  switch (outcome.status) {
    case "ok":
      return null;
    case "wrong":
      return `Wrong PIN. ${outcome.attemptsLeft} more ${
        outcome.attemptsLeft === 1 ? "try" : "tries"
      } before a short wait.`;
    case "cooling-down":
      return `Too many wrong PINs. Try again after ${new Date(
        outcome.retryAt,
      ).toLocaleTimeString()}.`;
    case "invalid-pin":
      return "A PIN is 4 to 8 digits.";
    case "unavailable":
      return "The PIN lock needs a secure connection (HTTPS or localhost) in this browser.";
    case "error":
      return `The PIN could not be checked: ${outcome.message}.`;
  }
}

function PinInput({
  id,
  value,
  onChange,
  testId,
  autoFocus,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  testId: string;
  autoFocus?: boolean;
}) {
  return (
    <Input
      id={id}
      type="password"
      inputMode="numeric"
      autoComplete="off"
      maxLength={8}
      value={value}
      onChange={(event) => onChange(event.target.value.replace(/\D/g, ""))}
      data-testid={testId}
      autoFocus={autoFocus}
    />
  );
}

function ResetTerminalDialog({
  open,
  onOpenChange,
  onReset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReset: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset the terminal?</DialogTitle>
          <DialogDescription>
            This removes the PIN and erases the terminal's saved data in this
            browser: paper portfolio, watchlist, price alerts, and mode history.
            Your real wallet and its keys are not touched.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onReset}
            data-testid="terminal-pin-reset-confirm"
          >
            Reset terminal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TerminalLockScreen({
  lock,
  firedAlertCount,
}: {
  lock: PinLockHandle;
  firedAlertCount: number;
}) {
  const [pin, setPin] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const pinId = useId();

  return (
    <div className="flex min-h-full w-full items-center justify-center bg-bg px-4 py-10">
      <section
        aria-labelledby="terminal-lock-title"
        className="flex w-full max-w-sm flex-col gap-4 rounded-md border border-border/70 p-6"
        data-testid="terminal-lock-screen"
      >
        <div className="flex items-center gap-2">
          <Lock className="size-5 text-accent" />
          <h1
            id="terminal-lock-title"
            className="text-base font-semibold text-txt"
          >
            Terminal locked
          </h1>
        </div>
        {lock.loadError ? (
          <p role="alert" className="text-sm text-warn">
            {lock.loadError}, so the terminal can't check your PIN. Reset the
            terminal to set a new one.
          </p>
        ) : (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (checking) return;
              setChecking(true);
              setError(null);
              void lock.unlock(pin).then((outcome) => {
                setChecking(false);
                setPin("");
                setError(describePinOutcome(outcome));
              });
            }}
          >
            <label htmlFor={pinId} className="text-xs text-muted">
              Enter your PIN to open the crypto terminal.
            </label>
            <PinInput
              id={pinId}
              value={pin}
              onChange={setPin}
              testId="terminal-pin-input"
              autoFocus
            />
            <Button
              type="submit"
              disabled={checking || pin.length < 4}
              data-testid="terminal-pin-unlock"
            >
              {checking ? "Checking…" : "Unlock"}
            </Button>
          </form>
        )}
        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}
        {firedAlertCount > 0 ? (
          <p className="text-xs text-txt" data-testid="terminal-lock-alerts">
            {firedAlertCount} price {firedAlertCount === 1 ? "alert" : "alerts"}{" "}
            fired while locked. Unlock to see{" "}
            {firedAlertCount === 1 ? "it" : "them"}.
          </p>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setConfirmReset(true)}
          data-testid="terminal-pin-forgot"
        >
          Forgot your PIN?
        </Button>
      </section>
      <ResetTerminalDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        onReset={() => {
          setConfirmReset(false);
          lock.resetTerminal();
        }}
      />
    </div>
  );
}

function PinSettingsDialog({
  lock,
  open,
  onOpenChange,
}: {
  lock: PinLockHandle;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const hasPin = lock.status !== "none";
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [minutes, setMinutes] = useState<AutoLockMinutes>(
    lock.autoLockMinutes ?? DEFAULT_AUTO_LOCK_MINUTES,
  );
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const currentId = useId();
  const nextId = useId();
  const confirmId = useId();

  const finish = (outcome: PinLockOutcome) => {
    setWorking(false);
    setCurrent("");
    const message = describePinOutcome(outcome);
    setError(message);
    if (message === null) {
      setNext("");
      setConfirm("");
      onOpenChange(false);
    }
  };

  const save = () => {
    const changingPin = !hasPin || next.length > 0 || confirm.length > 0;
    if (changingPin && !isValidPin(next)) {
      setError("A PIN is 4 to 8 digits.");
      return;
    }
    if (changingPin && next !== confirm) {
      setError("The two new PINs don't match.");
      return;
    }
    setWorking(true);
    setError(null);
    void (
      hasPin
        ? lock.changeLock(current, changingPin ? next : null, minutes)
        : lock.setPin(next, minutes)
    ).then(finish);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) {
          setCurrent("");
          setNext("");
          setConfirm("");
          setError(null);
        }
        onOpenChange(value);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {hasPin ? "PIN settings" : "Set a terminal PIN"}
          </DialogTitle>
          <DialogDescription>
            The PIN locks this terminal in this browser. It is not your wallet
            password and is never sent anywhere. Forgetting it means resetting
            the terminal's saved data.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!working) save();
          }}
        >
          {hasPin ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={currentId} className="text-xs text-muted">
                Current PIN
              </label>
              <PinInput
                id={currentId}
                value={current}
                onChange={setCurrent}
                testId="terminal-pin-current"
              />
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <label htmlFor={nextId} className="text-xs text-muted">
              {hasPin
                ? "New PIN (leave empty to keep it)"
                : "New PIN (4 to 8 digits)"}
            </label>
            <PinInput
              id={nextId}
              value={next}
              onChange={setNext}
              testId="terminal-pin-new"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={confirmId} className="text-xs text-muted">
              Confirm new PIN
            </label>
            <PinInput
              id={confirmId}
              value={confirm}
              onChange={setConfirm}
              testId="terminal-pin-confirm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted">
              Lock after no activity for
            </span>
            <SegmentedControl
              value={`${minutes}`}
              onValueChange={(value) =>
                setMinutes(Number(value) as AutoLockMinutes)
              }
              items={AUTO_LOCK_ITEMS}
              aria-label="Auto-lock time"
            />
          </div>
          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            {hasPin ? (
              <Button
                type="button"
                variant="ghost"
                disabled={working || current.length < 4}
                onClick={() => {
                  setWorking(true);
                  setError(null);
                  void lock.removePin(current).then(finish);
                }}
                data-testid="terminal-pin-remove"
              >
                Remove PIN
              </Button>
            ) : null}
            <Button
              type="submit"
              disabled={working}
              data-testid="terminal-pin-save"
            >
              {working ? "Saving…" : hasPin ? "Save changes" : "Set PIN"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Header controls: Set PIN when none is set; Lock now and PIN settings otherwise. */
export function PinControls({ lock }: { lock: PinLockHandle }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <div className="flex items-center gap-1">
      {lock.status === "unlocked" ? (
        <Button
          variant="outline"
          size="sm"
          onClick={lock.lock}
          data-testid="terminal-lock-now"
        >
          <Lock className="size-3.5" /> Lock
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setSettingsOpen(true)}
        data-testid="terminal-pin-settings"
      >
        <KeyRound className="size-3.5" />
        {lock.status === "none" ? "Set PIN" : "PIN"}
      </Button>
      {settingsOpen ? (
        <PinSettingsDialog
          lock={lock}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
      ) : null}
    </div>
  );
}
