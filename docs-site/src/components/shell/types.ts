export interface SidebarGroup {
  group: string;
  pages: { slug: string; href: string; label: string }[];
}

export interface SearchItem {
  href: string;
  group: string;
  title: string;
  description: string;
  keywords: string[];
  text: string;
}
