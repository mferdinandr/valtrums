import type { MDXComponents } from "mdx/types";
import { Accordion, AccordionGroup, Card, Columns, Info, Note, Step, Steps, Tip, Warning } from "@/components/mdx/blocks";
import { Anchor, H2, H3, Table } from "@/components/mdx/elements";
import { Tab, Tabs } from "@/components/mdx/tabs";
import { BattleStages } from "@/components/widgets/battle-stages";
import { DrawdownCalculator } from "@/components/widgets/drawdown-calculator";
import { RewardCalculator } from "@/components/widgets/reward-calculator";

/** Every component a page in content/ can use without importing it. */
const components: MDXComponents = {
  a: Anchor,
  h2: H2,
  h3: H3,
  table: Table,
  Accordion,
  AccordionGroup,
  Card,
  Columns,
  Info,
  Note,
  Step,
  Steps,
  Tab,
  Tabs,
  Tip,
  Warning,
  BattleStages,
  DrawdownCalculator,
  RewardCalculator,
};

export function useMDXComponents(): MDXComponents {
  return components;
}
