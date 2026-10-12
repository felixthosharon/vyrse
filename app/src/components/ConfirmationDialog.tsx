import { ShieldAlert } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useVyrse } from "@/lib/vyrse/store";
import type { ApprovalChoice } from "@/services";

const CHOICE_LABEL: Record<ApprovalChoice, string> = {
  once: "Allow once",
  session: "Allow this session",
  always: "Always allow",
  deny: "Deny",
};

/**
 * Hermes' approval prompt. Hermes decides what is risky (its approvals mode, danger
 * patterns and allowlist) and pauses the agent until the user answers here. There is no
 * way to dismiss this without answering; Deny is always offered and always safe.
 */
export function ConfirmationDialog() {
  const { pendingApproval, respondToApproval } = useVyrse();
  const open = pendingApproval !== null;
  const allows = (pendingApproval?.choices ?? []).filter((c) => c !== "deny");

  return (
    <AlertDialog open={open}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <div className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-destructive" strokeWidth={1.8} />
            <AlertDialogTitle>VYRSE wants permission</AlertDialogTitle>
          </div>
          <AlertDialogDescription asChild>
            <div className="space-y-3 pt-1">
              <p className="text-foreground/90">{pendingApproval?.description}</p>
              {pendingApproval?.command && (
                <pre className="field-scroll max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-surface/60 px-3 py-2 font-mono text-[12px] text-foreground">
                  {pendingApproval.command}
                </pre>
              )}
              {pendingApproval?.toolName && (
                <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
                  via {pendingApproval.toolName}
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <button
            type="button"
            onClick={() => respondToApproval("deny")}
            className={cn(buttonVariants({ variant: "outline" }))}
          >
            {CHOICE_LABEL.deny}
          </button>
          <div className="flex flex-wrap justify-end gap-2">
            {allows.map((choice) => (
              <button
                key={choice}
                type="button"
                onClick={() => respondToApproval(choice)}
                className={cn(buttonVariants({ variant: choice === "once" ? "default" : "outline" }))}
              >
                {CHOICE_LABEL[choice]}
              </button>
            ))}
          </div>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
