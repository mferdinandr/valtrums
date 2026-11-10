import { redirect } from "next/navigation";

/** Old bookmarks enter the same battle flow as every other visitor. */
export default function FormerPreviewPage() {
  redirect("/arena");
}
