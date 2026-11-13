"use client";

import { Children, isValidElement, useId, useState, type ReactElement, type ReactNode } from "react";

interface TabProps {
  title: string;
  children: ReactNode;
}

/** Only a marker: <Tabs> reads its title and renders its children. */
export function Tab({ children }: TabProps) {
  return <>{children}</>;
}

export function Tabs({ children }: { children: ReactNode }) {
  const tabs = Children.toArray(children).filter((c): c is ReactElement<TabProps> => isValidElement(c));
  const [active, setActive] = useState(0);
  const id = useId();
  return (
    <div className="tabs">
      <div role="tablist" className="tab-list">
        {tabs.map((tab, i) => (
          <button
            key={tab.props.title}
            type="button"
            role="tab"
            id={`${id}-tab-${i}`}
            aria-selected={i === active}
            aria-controls={`${id}-panel-${i}`}
            className="tab-button"
            onClick={() => setActive(i)}
          >
            {tab.props.title}
          </button>
        ))}
      </div>
      {tabs.map((tab, i) => (
        <div
          key={tab.props.title}
          role="tabpanel"
          id={`${id}-panel-${i}`}
          aria-labelledby={`${id}-tab-${i}`}
          hidden={i !== active}
          className="tab-panel"
        >
          {tab.props.children}
        </div>
      ))}
    </div>
  );
}
