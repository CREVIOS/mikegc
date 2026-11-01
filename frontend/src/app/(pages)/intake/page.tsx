import { redirect } from "next/navigation";
/** Intake opens on its requests, keeping any filters a link carried. */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(await searchParams))
    for (const item of Array.isArray(value) ? value : value ? [value] : [])
      params.append(name, item);
  const query = params.toString();
  redirect(query ? `/intake/requests?${query}` : "/intake/requests");
}
