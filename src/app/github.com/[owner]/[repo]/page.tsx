import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isSafeRepoSlug } from "@/lib/repo-url";
import { getStore } from "@/server/store";
import { ScanStart } from "@/components/story/ScanStart";
import { StoryView } from "@/components/story/StoryView";

interface Props {
  params: Promise<{ owner: string; repo: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { owner, repo } = await params;
  const store = await getStore();
  const stored = await store.getStory(owner, repo);
  const title = `${owner}/${repo}`;
  if (!stored) {
    return { title, description: `Excavate the history of ${title} — start the scan.` };
  }
  const s = stored.story.stats;
  return {
    title,
    description: `${s.totalCommits} commits, ${s.contributors} contributors, ${stored.story.eras.length} feature eras, bus factor ${stored.story.busFactor.score}. Dig into the full story of ${title}.`,
    openGraph: {
      title: `${owner}/${repo} · Commit Archaeology`,
      description: `${s.totalCommits} commits · ${stored.story.eras.length} eras · bus factor ${stored.story.busFactor.score}`,
    },
  };
}

/** Shareable story URL: /github.com/{owner}/{repo} */
export default async function RepoStoryPage({ params }: Props) {
  const { owner, repo: name } = await params;
  if (!isSafeRepoSlug(owner, name)) notFound();

  const store = await getStore();
  const stored = await store.getStory(owner, name);
  if (stored) return <StoryView story={stored.story} />;
  return <ScanStart owner={owner} name={name} />;
}
