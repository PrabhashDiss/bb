import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

export const OPTION_BASE_CLASS_NAME =
  "h-8 w-fit max-w-full min-w-0 items-center justify-start gap-1 px-1 text-xs leading-tight";
export const OPTION_INTERACTIVE_CLASS_NAME =
  "border-none bg-transparent shadow-none";
export const OPTION_CONTENT_CLASS_NAME = "flex min-w-0 items-center gap-1.5";
export const OPTION_TRIGGER_CONTENT_CLASS_NAME = "contents";
export const OPTION_MENU_CONTENT_CLASS_NAME =
  "max-h-[min(var(--radix-dropdown-menu-content-available-height),calc(100dvh-0.5rem))] w-max min-w-0 max-w-96 overflow-auto overflow-x-hidden overscroll-contain";
export const OPTION_MUTED_CLASS_NAME =
  "text-muted-foreground hover:text-muted-foreground";

export interface OptionDisplayProps {
  label: string;
  value: ReactNode;
  leading?: ReactNode;
  compactValue?: ReactNode;
  className?: string;
  tooltip?: ReactNode;
  onClick?: () => void;
}

export function OptionDisplay({
  label,
  value,
  leading,
  compactValue,
  className,
  tooltip,
  onClick,
}: OptionDisplayProps) {
  const defaultTitle =
    typeof value === "string" ? `${label}: ${value}` : undefined;

  const content = (
    <span className={OPTION_CONTENT_CLASS_NAME}>
      {leading}
      <span className="sr-only">{label}: </span>
      <span className="min-w-0 truncate" data-promptbox-full-label="">
        {value}
      </span>
      {compactValue ? (
        <span className="min-w-0 truncate" data-promptbox-compact-label="">
          {compactValue}
        </span>
      ) : null}
    </span>
  );

  const sharedProps = {
    "data-option-display": "",
    title: tooltip ? undefined : defaultTitle,
    className: cn(
      "inline-flex",
      OPTION_BASE_CLASS_NAME,
      (tooltip || onClick) &&
        "rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      onClick && "cursor-pointer transition-colors hover:bg-state-hover",
      OPTION_MUTED_CLASS_NAME,
      className,
    ),
  };

  const display = onClick ? (
    <button type="button" onClick={onClick} {...sharedProps}>
      {content}
    </button>
  ) : (
    <div tabIndex={tooltip ? 0 : undefined} {...sharedProps}>
      {content}
    </div>
  );

  if (!tooltip) {
    return display;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{display}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
