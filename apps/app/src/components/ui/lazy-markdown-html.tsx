import ReactMarkdown, { type Options } from "react-markdown";
import { defineSplit, SplitLoadFailure } from "@/lib/define-split";
import { Skeleton } from "@bb/shared-ui/skeleton";

export const LazyMarkdownHtmlRender = defineSplit<{ source: string }>({
  id: "markdown-html-render",
  preload: "render",
  load: () =>
    import("./markdown-html-render").then((module) => module.MarkdownHtmlRender),
  loading: () => (
    <Skeleton className="h-16 w-full" aria-label="Loading HTML preview" />
  ),
  error: ({ retry, source }) => (
    <>
      <pre className="overflow-auto whitespace-pre-wrap">{source}</pre>
      <SplitLoadFailure retry={retry} />
    </>
  ),
});

export const LazyMarkdownHtml = defineSplit<Options>({
  id: "markdown-html",
  preload: "render",
  load: () => import("./markdown-html").then((module) => module.MarkdownHtml),
  loading: (props) => (
    <>
      <ReactMarkdown {...props} skipHtml />
      <Skeleton className="h-4 w-32" aria-label="Loading embedded HTML" />
    </>
  ),
  error: ({ retry, ...props }) => (
    <>
      <ReactMarkdown {...props} skipHtml />
      <SplitLoadFailure retry={retry} />
    </>
  ),
});
