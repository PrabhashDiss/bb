import { useEffect, useMemo, useRef, useState } from "react";
import { useAppThemeEpoch } from "@/hooks/useAppTheme";
import { usePreferredTheme } from "@/hooks/useTheme";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@bb/shared-ui/dialog";

const THEME_PROPERTIES = [
  "--canvas",
  "--ink",
  "--background",
  "--foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--ring",
  "--destructive",
  "--font-sans",
  "--font-mono",
];

type RenderTheme = {
  appearance: "light" | "dark";
  variables: Record<string, string>;
};

function readTheme(): RenderTheme {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  return {
    appearance: root.classList.contains("dark") ? "dark" : "light",
    variables: Object.fromEntries(
      THEME_PROPERTIES.map((name) => [
        name,
        style.getPropertyValue(name).trim(),
      ]),
    ),
  };
}

function documentBridge(properties: string[], initialTheme: RenderTheme) {
  const themeStyle = document.createElement("style");
  document.head.append(themeStyle);
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const applyTheme = (theme: unknown) => {
    if (
      !isRecord(theme) ||
      (theme.appearance !== "light" && theme.appearance !== "dark") ||
      !isRecord(theme.variables) ||
      Object.keys(theme).length !== 2 ||
      Object.keys(theme.variables).some((key) => !properties.includes(key))
    )
      return;
    const declarations: string[] = [];
    for (const [name, value] of Object.entries(theme.variables)) {
      if (
        typeof value !== "string" ||
        value.length > 512 ||
        /[;{}<>]/.test(value)
      )
        return;
      declarations.push(`${name}:${value}`);
    }
    themeStyle.textContent = `:root{color-scheme:${theme.appearance};${declarations.join(";")}}`;
  };
  applyTheme(initialTheme);
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (
      event.source !== window.parent ||
      !isRecord(data) ||
      data.type !== "bb-html-theme" ||
      Object.keys(data).length !== 2
    )
      return;
    applyTheme(data.theme);
  });
  let pending = false;
  let previousHeight = 0;
  const measure = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      const root = document.documentElement;
      const contentHeight =
        root.scrollHeight > root.clientHeight
          ? root.scrollHeight
          : root.getBoundingClientRect().height;
      if (!Number.isFinite(contentHeight)) return;
      const height = Math.max(120, Math.ceil(contentHeight));
      if (height === previousHeight) return;
      previousHeight = height;
      window.parent.postMessage({ type: "bb-html-size", height }, "*");
    }, 100);
  };
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      const observer = new ResizeObserver(measure);
      observer.observe(document.documentElement);
      if (document.body) observer.observe(document.body);
      new MutationObserver(measure).observe(document.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
        characterData: true,
      });
      void document.fonts.ready.then(measure);
      measure();
    },
    { once: true },
  );
  window.addEventListener("load", measure);
  window.addEventListener("resize", measure);
}

function scriptJson(value: RenderTheme | string[]): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function renderDocument(source: string, theme: RenderTheme): string {
  const markup =
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<style>html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);line-height:1.5}body{margin:0}code,pre{font-family:var(--font-mono)}</style>" +
    `<script>(${documentBridge.toString()})(${scriptJson(THEME_PROPERTIES)},${scriptJson(theme)});</script>`;
  const scan = source.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi,
    (match) => " ".repeat(match.length),
  );
  const template = /<template\b/i.exec(scan);
  const head = /<head(?:\s[^>]*)?>/i.exec(scan);
  if (head && (!template || head.index < template.index)) {
    const at = head.index + head[0].length;
    return source.slice(0, at) + markup + source.slice(at);
  }
  const html = /<html(?:\s[^>]*)?>/i.exec(scan);
  if (html && (!template || html.index < template.index)) {
    const at = html.index + html[0].length;
    return source.slice(0, at) + `<head>${markup}</head>` + source.slice(at);
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(source);
  const at = doctype?.[0].length ?? 0;
  return (
    (doctype ? source.slice(0, at) : "<!doctype html>") +
    `<head>${markup}</head>` +
    source.slice(at)
  );
}

function HtmlRenderFrame({
  source,
  expanded = false,
}: {
  source: string;
  expanded?: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(224);
  const appearance = usePreferredTheme();
  const themeEpoch = useAppThemeEpoch();
  const srcDoc = useMemo(() => renderDocument(source, readTheme()), [source]);
  const postTheme = () =>
    frameRef.current?.contentWindow?.postMessage(
      {
        type: "bb-html-theme",
        theme: readTheme(),
      },
      "*",
    );
  useEffect(postTheme, [appearance, themeEpoch]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let nextHeight = 224;
    const onMessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      const frame = frameRef.current;
      if (
        frame === null ||
        frame.contentWindow === null ||
        event.source !== frame.contentWindow ||
        typeof data !== "object" ||
        data === null ||
        Array.isArray(data) ||
        !("type" in data) ||
        data.type !== "bb-html-size" ||
        !("height" in data) ||
        typeof data.height !== "number" ||
        !Number.isFinite(data.height) ||
        data.height < 120 ||
        Object.keys(data).length !== 2
      )
        return;
      nextHeight = Math.ceil(data.height);
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        setHeight(nextHeight);
      }, 100);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
    };
  }, []);
  return (
    <iframe
      ref={frameRef}
      title={expanded ? "Expanded HTML preview" : "HTML preview"}
      srcDoc={srcDoc}
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      onLoad={postTheme}
      className="block w-full border-0"
      style={{ height: expanded ? "100%" : height, colorScheme: appearance }}
    />
  );
}

export function MarkdownHtmlRender({ source }: { source: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div data-html-preview="">
      <div className="flex justify-end px-2 py-1">
        <button
          type="button"
          aria-label="Expand HTML preview"
          onClick={() => setExpanded(true)}
          className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Expand
        </button>
      </div>
      <HtmlRenderFrame source={source} />
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="flex h-[84dvh] w-full max-w-none flex-col gap-2 md:w-[min(96vw,88rem)]">
          <DialogTitle>HTML preview</DialogTitle>
          <DialogDescription className="sr-only">
            A separate expanded instance of the document.
          </DialogDescription>
          <div className="min-h-0 flex-1">
            <HtmlRenderFrame source={source} expanded />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
