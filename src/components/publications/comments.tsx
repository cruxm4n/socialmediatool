"use client";

import { useState, useTransition } from "react";
import { MessageSquare } from "lucide-react";
import { toast } from "sonner";

import { PersonAvatar } from "@/components/shared/org-avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/dates";
import type { Comment, Profile } from "@/lib/types";
import { cn } from "@/lib/utils";
import { leaveIfExpired } from "@/lib/action-result";
import { addComment } from "@/server/actions";

export function CommentThread({
  postId,
  comments,
  profiles,
  timezone,
}: {
  postId: string;
  comments: Comment[];
  profiles: Profile[];
  timezone: string;
}) {
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!body.trim()) return;
    startTransition(async () => {
      try {
        const result = await addComment({ postId, body });
        if (leaveIfExpired(result)) return;
        if (result.ok) {
          setBody("");
          toast.success(result.message);
        } else {
          toast.error(result.message);
        }
      } catch {
        toast.error("La confirmation n'a pas été reçue. Votre texte est conservé ; vérifiez les commentaires avant de réessayer.");
      }
    });
  };

  return (
    <div className="grid grid-cols-1 gap-4">
      {comments.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <MessageSquare className="size-4" /> Aucun commentaire pour le moment.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-4">
          {comments.map((comment) => {
            const author = profiles.find((profile) => profile.id === comment.authorId);
            return (
              <li key={comment.id} className="flex gap-3">
                <PersonAvatar profile={author} size="sm" className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="font-medium">{author?.fullName ?? "Utilisateur"}</span>
                    <span className="text-xs text-muted-foreground">
                      version {comment.version} · {formatDateTime(comment.createdAt, timezone)}
                    </span>
                  </p>
                  <p
                    className={cn(
                      "mt-1 rounded-xl px-3 py-2 text-sm leading-relaxed whitespace-pre-line",
                      comment.kind === "change_request" ? "bg-tone-rose-soft text-foreground" : "bg-muted",
                    )}
                  >
                    {comment.kind === "change_request" && (
                      <span className="mb-0.5 block text-xs font-semibold text-tone-rose">Demande de modification</span>
                    )}
                    {comment.body}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <form onSubmit={submit} className="grid grid-cols-1 gap-2">
        <label htmlFor={`comment-${postId}`} className="sr-only">
          Ajouter un commentaire
        </label>
        <Textarea
          id={`comment-${postId}`}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Ajouter un commentaire…"
          rows={2}
          maxLength={2000}
        />
        <Button type="submit" variant="outline" size="lg" disabled={!body.trim() || pending} className="justify-self-end">
          {pending ? "Envoi…" : "Commenter"}
        </Button>
      </form>
    </div>
  );
}
