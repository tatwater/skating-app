import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { convexReact, fakes, resetFakes } from '../testMocks';
import { panelRouter, resetPanelFakes } from './panelTestMocks';

vi.mock('convex/react', () => convexReact);
vi.mock('@tanstack/react-router', () => panelRouter);
vi.mock('@/lib/analytics', async (load) => ({
  ...(await load<typeof import('@/lib/analytics')>()),
  useAnalytics: () => ({ capture: fakes.capture }),
}));

import { type CommentNodeData, Comments, CommentThreadView } from './CommentThread';

const now = new Date(2027, 0, 16, 12, 0).getTime();
const author = (name: string, username = name.toLowerCase().replace(' ', '')) => ({
  username,
  displayName: name,
});

const NODES: CommentNodeData[] = [
  {
    id: 'c1',
    hidden: false,
    comment: {
      body: 'Did the lead at the bridge look any smaller from the launch?',
      authorId: 'u2',
      author: author('Sarah Berman'),
      isOwn: false,
      createdAt: now - 60 * 60_000,
    },
    replies: [
      {
        id: 'c2',
        hidden: false,
        comment: {
          body: 'Same as Thursday from what I could see.',
          authorId: 'u1',
          author: author('Pat Lacasse'),
          isOwn: true,
          createdAt: now - 50 * 60_000,
          editedAt: now - 40 * 60_000,
        },
        replies: [],
      },
    ],
  },
  { id: 'c3', hidden: true, comment: null, replies: [] },
  {
    id: 'c4',
    hidden: false,
    comment: {
      body: '',
      redacted: true,
      authorId: 'u3',
      author: { username: '', displayName: 'Deleted user', deleted: true },
      isOwn: false,
      createdAt: now - 25 * 60_000,
    },
    replies: [],
  },
];

/** The compose box's own action — "Reply" is also the toggle on each comment. */
function submitOf(box: HTMLElement, name: string): HTMLElement {
  return within(box.closest('[data-slot="comment-compose"]') as HTMLElement).getByRole('button', {
    name,
  });
}

beforeEach(() => {
  resetFakes();
  resetPanelFakes();
});

function view(over: Partial<Parameters<typeof CommentThreadView>[0]> = {}) {
  const props = {
    nodes: NODES,
    now,
    viewer: { displayName: 'Kate Donovan' },
    onCreate: vi.fn().mockResolvedValue(undefined),
    onEdit: vi.fn().mockResolvedValue(undefined),
    onRemove: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
  render(<CommentThreadView {...props} />);
  return props;
}

describe('CommentThreadView', () => {
  it('counts what can be read, indents replies, and says what’s hidden or gone', () => {
    view();
    expect(screen.getByRole('heading', { name: 'Comments' }).parentElement).toHaveTextContent('3');
    const reply = screen.getByText('Same as Thursday from what I could see.').closest('li');
    expect(reply).toHaveAttribute('data-reply');
    expect(within(reply as HTMLElement).getByText('50 min · edited')).toBeInTheDocument();
    expect(screen.getByText('This comment is hidden.')).toBeInTheDocument();
    // A departed author: the standing-in line, and a name that links nowhere.
    expect(screen.getByText('Deleted user').closest('a')).toBeNull();
    expect(screen.getByRole('link', { name: 'Sarah Berman' })).toHaveAttribute(
      'href',
      '/u/$username'.replace('$username', 'sarahberman'),
    );
  });

  it('replies under a top-level comment only', async () => {
    const props = view();
    const replyButtons = screen.getAllByRole('button', { name: 'Reply' });
    expect(replyButtons).toHaveLength(2); // c1 and c4, never the nested c2
    await userEvent.click(replyButtons[0] as HTMLElement);
    const box = screen.getByRole('textbox', { name: 'Write a reply' });
    expect(box).toHaveFocus();
    await userEvent.type(box, 'Thanks!');
    await userEvent.click(submitOf(box, 'Reply'));
    expect(props.onCreate).toHaveBeenCalledWith('Thanks!', 'c1');
  });

  it('lets the author edit and delete their own', async () => {
    const props = view();
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'Edit your comment' });
    await userEvent.clear(box);
    await userEvent.type(box, 'Smaller today.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(props.onEdit).toHaveBeenCalledWith('c2', 'Smaller today.');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(props.onRemove).toHaveBeenCalledWith('c2');
  });

  it('posts from the compose box, and keeps the words when it fails', async () => {
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    view({ onCreate });
    const box = screen.getByRole('textbox', { name: 'Add a comment' });
    const post = screen.getByRole('button', { name: 'Post' });
    expect(post).toBeDisabled();
    await userEvent.type(box, 'Going to look this afternoon.');
    await userEvent.click(post);
    expect(await screen.findByRole('alert')).toHaveTextContent('Not posted.');
    expect(box).toHaveValue('Going to look this afternoon.');
    await userEvent.click(post);
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('cancels a reply', async () => {
    view();
    await userEvent.click(screen.getAllByRole('button', { name: 'Reply' })[0] as HTMLElement);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'Write a reply' })).toBeNull();
  });

  it('is read-only without a viewer, and says when it’s empty', () => {
    view({ nodes: [], viewer: null });
    expect(screen.getByText('No comments yet.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
  });
});

describe('Comments', () => {
  const adult = {
    _id: 'u9',
    status: 'active',
    displayName: 'Kate Donovan',
    dateOfBirth: '1990-01-01',
  };

  it('lets an active adult comment, and counts the reply shape only', async () => {
    fakes.queries.set('comments:listByReport', NODES);
    fakes.queries.set('profiles:current', adult);
    render(<Comments reportId="r1" now={now} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Add a comment' }), 'Nice.');
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));
    expect(fakes.mutations.get('comments:create')).toHaveBeenCalledWith({
      reportId: 'r1',
      body: 'Nice.',
    });
    expect(fakes.capture).toHaveBeenCalledWith('comment_created', { is_reply: false });

    await userEvent.click(screen.getAllByRole('button', { name: 'Reply' })[0] as HTMLElement);
    const replyBox = screen.getByRole('textbox', { name: 'Write a reply' });
    await userEvent.type(replyBox, 'Same.');
    await userEvent.click(submitOf(replyBox, 'Reply'));
    expect(fakes.mutations.get('comments:create')).toHaveBeenCalledWith({
      reportId: 'r1',
      body: 'Same.',
      parentCommentId: 'c1',
    });
    expect(fakes.capture).toHaveBeenCalledWith('comment_created', { is_reply: true });

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(fakes.mutations.get('comments:remove')).toHaveBeenCalledWith({ commentId: 'c2' });
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Edit your comment' }), '!');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(fakes.mutations.get('comments:update')).toHaveBeenCalledWith({
      commentId: 'c2',
      body: 'Same as Thursday from what I could see.!',
    });
    // Anyone else's comment can be flagged.
    expect(screen.getAllByRole('button', { name: 'Flag' }).length).toBeGreaterThan(0);
  });

  it('keeps a minor read-only (D41)', () => {
    fakes.queries.set('comments:listByReport', NODES);
    fakes.queries.set('profiles:current', { ...adult, dateOfBirth: '2012-06-01' });
    render(<Comments reportId="r1" now={now} />);
    expect(screen.queryByRole('textbox', { name: 'Add a comment' })).toBeNull();
  });

  it('renders an empty thread while it loads', () => {
    render(<Comments reportId="r1" now={now} />);
    expect(screen.getByText('No comments yet.')).toBeInTheDocument();
  });
});
