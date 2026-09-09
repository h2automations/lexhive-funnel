# GTM container export

Export the finished container from GTM (Admin → Export Container) and commit the
JSON here.

Configuration that exists only in someone's account is configuration nobody can
review — the same reason `n8n/` holds workflow exports. It also means the one
field the deduplication depends on (the Meta Pixel tag's Event ID, mapped to
`{{DLV - event_id}}`) is visible in a diff rather than buried in a UI.

See `../docs/gtm-setup.md` for the tag-by-tag build.
