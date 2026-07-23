import { api } from '@skating/convex/api';
import { useMutation } from 'convex/react';
import { useState } from 'react';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Textarea } from './ui/textarea';

/**
 * Contact-support / report-a-bug form (D35) — the one operator-adjacent surface that ships on web AND
 * mobile. A *submission* path (not the operator inbox): any signed-in user files a ticket, and a
 * suspended/banned user can still submit an **appeal** (`category: account`), since `support.create`
 * intentionally doesn't gate on status. Auto-captures platform + app version the server stores as
 * context an email can't.
 */
const CATEGORIES = [
  { value: 'bug', label: 'Bug report' },
  { value: 'account', label: 'Account / appeal' },
  { value: 'safety', label: 'Safety concern' },
  { value: 'other', label: 'Something else' },
] as const;

const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? 'web';

export function ContactSupport() {
  const create = useMutation(api.support.create);
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]['value']>('bug');
  const [body, setBody] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  const submit = async () => {
    if (!body.trim()) return;
    setState('sending');
    try {
      await create({
        category,
        body: body.trim(),
        context: { platform: 'web', appVersion: APP_VERSION },
      });
      setBody('');
      setState('sent');
    } catch {
      setState('error');
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        {state === 'sent' ? (
          <p className="text-foreground text-sm">
            Thanks — we got it. We'll follow up if we need more.{' '}
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => setState('idle')}
            >
              Send another
            </button>
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="support-category">Topic</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as typeof category)}>
                <SelectTrigger id="support-category" size="sm" className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="support-body">Message</Label>
              <Textarea
                id="support-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="What's going on?"
                rows={4}
              />
            </div>
            {state === 'error' ? (
              <p className="text-destructive text-sm">Couldn't send that. Please try again.</p>
            ) : null}
            <div>
              <Button size="sm" onClick={submit} disabled={!body.trim() || state === 'sending'}>
                {state === 'sending' ? 'Sending…' : 'Send'}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
