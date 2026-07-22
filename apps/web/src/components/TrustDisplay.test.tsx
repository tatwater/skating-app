import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TrustAvatar, TrustClassChip } from './TrustDisplay';

describe('TrustClassChip', () => {
  it('renders the human class label', () => {
    render(<TrustClassChip trustClass="expert" />);
    expect(screen.getByText('Expert')).toBeInTheDocument();
  });

  it('renders nothing for a null class — never "Not trusted" (D50)', () => {
    const { container } = render(<TrustClassChip trustClass={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('TrustAvatar', () => {
  it('labels the ring with the class for assistive tech when a class is present', () => {
    render(<TrustAvatar displayName="Ada" trustClass="leader" />);
    // The initial-fallback avatar renders the first letter…
    expect(screen.getByText('A')).toBeInTheDocument();
    // …and the class surfaces as an accessible label + a title tooltip.
    expect(screen.getByText('Leader skater')).toBeInTheDocument();
    expect(screen.getByTitle('Leader skater')).toBeInTheDocument();
  });

  it('renders a plain avatar (no class label) when the class is null', () => {
    render(<TrustAvatar displayName="Boots" trustClass={null} />);
    expect(screen.getByText('B')).toBeInTheDocument();
    expect(screen.queryByText(/skater$/)).not.toBeInTheDocument();
  });
});
