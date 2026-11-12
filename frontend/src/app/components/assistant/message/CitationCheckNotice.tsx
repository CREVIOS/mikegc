import { TriangleAlert } from "lucide-react";

/**
 * Bangladeshi law-report citations the answer gave without having read them
 * in any document, statute page, web page or message (backend
 * lib/bangladesh/citations.ts). They may be right, but nothing in the answer
 * shows it, so the lawyer is told to check them in the report.
 */
export function CitationCheckNotice({ unverified }: { unverified: string[] }) {
    if (!unverified.length) return null;
    const one = unverified.length === 1;
    return (
        <div
            role="note"
            aria-label="Citations not verified"
            className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
            <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 space-y-1">
                <p className="font-medium">
                    {one ? "1 citation not verified" : `${unverified.length} citations not verified`}
                </p>
                <p>
                    {one ? "This authority does" : "These authorities do"} not
                    appear in any document, statute or page read for this
                    answer. Check {one ? "it" : "them"} in the law report before
                    relying on {one ? "it" : "them"}.
                </p>
                <ul className="list-disc pl-5 [overflow-wrap:anywhere]">
                    {unverified.map((citation) => (
                        <li key={citation}>{citation}</li>
                    ))}
                </ul>
            </div>
        </div>
    );
}
