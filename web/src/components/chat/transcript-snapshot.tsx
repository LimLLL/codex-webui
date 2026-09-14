/** React's pre-mutation lifecycle captures the old DOM before an inline insertion changes it. */
import { Component, type ReactNode } from 'react';

export class TranscriptSnapshot extends Component<{
  beforeCommit: () => void;
  children: ReactNode;
}> {
  /** Captures only committed DOM; function-component layout effects run too late for this half. */
  getSnapshotBeforeUpdate(): null {
    this.props.beforeCommit();
    return null;
  }
  /** Geometry correction belongs to the parent virtualizer owner's later layout effect. */
  componentDidUpdate(): void {
    /* The matching snapshot lifecycle is intentionally read-only. */
  }
  /** Keeps the same children and ancestor identity for every update. */
  render(): ReactNode {
    return this.props.children;
  }
}
