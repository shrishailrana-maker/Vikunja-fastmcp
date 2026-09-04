# Vikunja V2 API Reference

This file is generated from the sanitized local OpenAPI snapshot.

- Raw specification: [`vikunja-v2-openapi.json`](vikunja-v2-openapi.json)
- Upstream API documentation: https://vikunja.io/docs/api-documentation/
- Minimum supported official release: https://github.com/go-vikunja/vikunja/releases/tag/v2.6.0
- API generation: live Vikunja 2.6.0 service
- Snapshot date: 2026-09-04
- OpenAPI version: 3.1.0
- API title: Vikunja API
- API version: v2.6.0

Vikunja generates this OpenAPI document at runtime. The checked-in copy is
the latest-only HTTP authority for this MCP and must be refreshed when the
minimum supported Vikunja release changes. Instance URLs are replaced with
`https://vikunja.example.com`; no credential is stored.

## Operations

| Method | Path | Operation | Summary |
| --- | --- | --- | --- |
| GET | `/{entitykind}/{entityid}/reactions` | `reactions-list` | List reactions for an entity |
| POST | `/{entitykind}/{entityid}/reactions` | `reactions-create` | React to an entity |
| POST | `/{entitykind}/{entityid}/reactions/delete` | `reactions-delete` | Remove a reaction from an entity |
| GET | `/admin/overview` | `admin-overview` | Admin overview |
| GET | `/admin/projects` | `admin-projects-list` | List all projects (admin) |
| PATCH | `/admin/projects/{id}/owner` | `admin-projects-patch-owner` | Reassign a project's owner (admin) |
| GET | `/admin/users` | `admin-users-list` | List users (admin) |
| POST | `/admin/users` | `admin-users-create` | Create a user (admin) |
| DELETE | `/admin/users/{id}` | `admin-users-delete` | Delete a user (admin) |
| PATCH | `/admin/users/{id}/admin` | `admin-users-patch-admin` | Promote or demote a user (admin) |
| PATCH | `/admin/users/{id}/password` | `admin-users-set-password` | Set a user's password (admin) |
| POST | `/admin/users/{id}/password-reset-email` | `admin-users-password-reset-email` | Send a password-reset email (admin) |
| PATCH | `/admin/users/{id}/status` | `admin-users-patch-status` | Set a user's status (admin) |
| GET | `/avatar/{username}` | `avatar-get` | Get a user's avatar |
| POST | `/filters` | `filters-create` | Create a saved filter |
| DELETE | `/filters/{filter}` | `filters-delete` | Delete a saved filter |
| GET | `/filters/{filter}` | `filters-read` | Get a saved filter |
| PATCH | `/filters/{filter}` | `patch-filters-read` | Update a saved filter (partial) |
| PUT | `/filters/{filter}` | `filters-update` | Update a saved filter |
| GET | `/health` | `health` | Healthcheck |
| GET | `/info` | `info` | Instance info |
| GET | `/labels` | `labels-list` | List labels |
| POST | `/labels` | `labels-create` | Create a label |
| DELETE | `/labels/{id}` | `labels-delete` | Delete a label |
| GET | `/labels/{id}` | `labels-read` | Get a label |
| PATCH | `/labels/{id}` | `patch-labels-read` | Update a label (partial) |
| PUT | `/labels/{id}` | `labels-update` | Update a label |
| POST | `/login` | `auth-login` | Login |
| POST | `/logout` | `auth-logout` | Logout |
| POST | `/migration/csv/detect` | `migration-csv-detect` | Detect a CSV file's structure |
| POST | `/migration/csv/migrate` | `migration-csv-migrate` | Import a CSV file |
| POST | `/migration/csv/preview` | `migration-csv-preview` | Preview a CSV import |
| GET | `/migration/csv/status` | `migration-csv-status` | Get the CSV migration status |
| POST | `/migration/planka/migrate` | `migration-planka-migrate` | Migrate from planka |
| GET | `/migration/planka/status` | `migration-planka-status` | Get the migration status for planka |
| POST | `/migration/ticktick/migrate` | `migration-ticktick-migrate` | Migrate from ticktick |
| GET | `/migration/ticktick/status` | `migration-ticktick-status` | Get the migration status for ticktick |
| POST | `/migration/vikunja-file/migrate` | `migration-vikunja-file-migrate` | Migrate from vikunja-file |
| GET | `/migration/vikunja-file/status` | `migration-vikunja-file-status` | Get the migration status for vikunja-file |
| POST | `/migration/wekan/migrate` | `migration-wekan-migrate` | Migrate from wekan |
| GET | `/migration/wekan/status` | `migration-wekan-status` | Get the migration status for wekan |
| DELETE | `/notifications` | `notifications-delete-all` | Delete all notifications |
| GET | `/notifications` | `notifications-list` | List notifications |
| POST | `/notifications` | `notifications-mark-all-read` | Mark all notifications as read |
| GET | `/notifications.atom` | `notifications-atom-feed` | Notifications Atom feed |
| PUT | `/notifications/{notificationid}` | `notifications-mark-read` | Mark a notification as (un-)read |
| POST | `/oauth/authorize` | `oauth-authorize` | OAuth 2.0 authorize endpoint |
| POST | `/oauth/token` | `oauth-token` | OAuth 2.0 token endpoint |
| GET | `/projects` | `projects-list` | List projects |
| POST | `/projects` | `projects-create` | Create a project |
| DELETE | `/projects/{id}` | `projects-delete` | Delete a project |
| GET | `/projects/{id}` | `projects-read` | Get a project |
| PATCH | `/projects/{id}` | `patch-projects-read` | Update a project (partial) |
| PUT | `/projects/{id}` | `projects-update` | Update a project |
| GET | `/projects/{project_id}/time-entries` | `project-time-entries-list` | List a project's time entries |
| DELETE | `/projects/{project}/background` | `projects-background-delete` | Remove a project background |
| GET | `/projects/{project}/background` | `projects-background-get` | Get a project background |
| PUT | `/projects/{project}/backgrounds/upload` | `projects-background-upload` | Upload a project background |
| GET | `/projects/{project}/shares` | `shares-list` | List the link shares of a project |
| POST | `/projects/{project}/shares` | `shares-create` | Share a project via link |
| DELETE | `/projects/{project}/shares/{share}` | `shares-delete` | Remove a link share from a project |
| GET | `/projects/{project}/shares/{share}` | `shares-read` | Get a single link share of a project |
| GET | `/projects/{project}/tasks` | `project-tasks-list` | List tasks in a project |
| POST | `/projects/{project}/tasks` | `tasks-create` | Create a task |
| POST | `/projects/{project}/tasks/bulk` | `tasks-bulk-create` | Create multiple tasks |
| GET | `/projects/{project}/tasks/by-index/{index}` | `tasks-read-by-index` | Get a task by its project index |
| GET | `/projects/{project}/teams` | `project-teams-list` | List the teams a project is shared with |
| POST | `/projects/{project}/teams` | `project-teams-create` | Share a project with a team |
| DELETE | `/projects/{project}/teams/{team}` | `project-teams-delete` | Remove a team from a project |
| PUT | `/projects/{project}/teams/{team}` | `project-teams-update` | Update a team's permission on a project |
| GET | `/projects/{project}/users` | `project-users-list` | List the users a project is shared with |
| POST | `/projects/{project}/users` | `project-users-create` | Share a project with a user |
| DELETE | `/projects/{project}/users/{user}` | `project-users-delete` | Remove a user's access to a project |
| PUT | `/projects/{project}/users/{user}` | `project-users-update` | Update a user's permission on a project |
| GET | `/projects/{project}/users/search` | `projects-users-search` | Search users with access to a project |
| GET | `/projects/{project}/views` | `project-views-list` | List the views of a project |
| POST | `/projects/{project}/views` | `project-views-create` | Create a view in a project |
| DELETE | `/projects/{project}/views/{view}` | `project-views-delete` | Delete a view of a project |
| GET | `/projects/{project}/views/{view}` | `project-views-read` | Get a single view of a project |
| PATCH | `/projects/{project}/views/{view}` | `patch-project-views-read` | Update a view of a project (partial) |
| PUT | `/projects/{project}/views/{view}` | `project-views-update` | Update a view of a project |
| GET | `/projects/{project}/views/{view}/buckets` | `buckets-list` | List the buckets of a kanban view |
| POST | `/projects/{project}/views/{view}/buckets` | `buckets-create` | Create a bucket in a kanban view |
| DELETE | `/projects/{project}/views/{view}/buckets/{bucket}` | `buckets-delete` | Delete a bucket of a kanban view |
| PUT | `/projects/{project}/views/{view}/buckets/{bucket}` | `buckets-update` | Update a bucket of a kanban view |
| PUT | `/projects/{project}/views/{view}/buckets/{bucket}/tasks` | `task-bucket-update` | Place a task in a kanban bucket |
| GET | `/projects/{project}/views/{view}/buckets/tasks` | `project-view-buckets-tasks-list` | List a kanban view's buckets with their tasks |
| GET | `/projects/{project}/views/{view}/tasks` | `project-view-tasks-list` | List tasks in a project view |
| GET | `/projects/{project}/webhooks` | `webhooks-list` | List a project's webhooks |
| POST | `/projects/{project}/webhooks` | `webhooks-create` | Create a webhook target in a project |
| DELETE | `/projects/{project}/webhooks/{webhook}` | `webhooks-delete` | Delete a webhook target |
| PUT | `/projects/{project}/webhooks/{webhook}` | `webhooks-update` | Update a webhook target's events |
| POST | `/projects/{projectid}/duplicate` | `projects-duplicate` | Duplicate a project |
| POST | `/register` | `auth-register` | Register |
| GET | `/routes` | `token-routes` | List API token routes |
| POST | `/shares/{share}/auth` | `auth-link-share` | Get an auth token for a link share |
| DELETE | `/subscriptions/{entity}/{entityID}` | `subscriptions-delete` | Unsubscribe from an entity |
| POST | `/subscriptions/{entity}/{entityID}` | `subscriptions-create` | Subscribe to an entity |
| GET | `/tasks` | `tasks-list` | List tasks across all projects |
| DELETE | `/tasks/{projecttask}` | `tasks-delete` | Delete a task |
| GET | `/tasks/{projecttask}` | `tasks-read` | Get a task |
| PATCH | `/tasks/{projecttask}` | `patch-tasks-read` | Update a task (partial) |
| PUT | `/tasks/{projecttask}` | `tasks-update` | Update a task |
| GET | `/tasks/{projecttask}/assignees` | `task-assignees-list` | List the assignees of a task |
| POST | `/tasks/{projecttask}/assignees` | `task-assignees-create` | Assign a user to a task |
| DELETE | `/tasks/{projecttask}/assignees/{user}` | `task-assignees-delete` | Remove an assignee from a task |
| PUT | `/tasks/{projecttask}/assignees/bulk` | `task-assignees-bulk` | Replace all assignees of a task |
| POST | `/tasks/{projecttask}/duplicate` | `tasks-duplicate` | Duplicate a task |
| GET | `/tasks/{projecttask}/labels` | `task-labels-list` | List the labels on a task |
| POST | `/tasks/{projecttask}/labels` | `task-labels-create` | Add a label to a task |
| DELETE | `/tasks/{projecttask}/labels/{label}` | `task-labels-delete` | Remove a label from a task |
| PUT | `/tasks/{projecttask}/labels/bulk` | `task-labels-bulk-replace` | Replace all labels on a task |
| PUT | `/tasks/{projecttask}/read` | `tasks-mark-read` | Mark a task as read |
| GET | `/tasks/{task_id}/time-entries` | `task-time-entries-list` | List a task's time entries |
| GET | `/tasks/{task}/attachments` | `task-attachments-list` | List a task's attachments |
| POST | `/tasks/{task}/attachments` | `task-attachments-upload` | Upload task attachments |
| DELETE | `/tasks/{task}/attachments/{attachment}` | `task-attachments-delete` | Delete a task attachment |
| GET | `/tasks/{task}/attachments/{attachment}` | `task-attachments-download` | Download a task attachment |
| GET | `/tasks/{task}/comments` | `task-comments-list` | List the comments of a task |
| POST | `/tasks/{task}/comments` | `task-comments-create` | Create a comment on a task |
| DELETE | `/tasks/{task}/comments/{commentid}` | `task-comments-delete` | Delete a comment of a task |
| GET | `/tasks/{task}/comments/{commentid}` | `task-comments-read` | Get a single comment of a task |
| PATCH | `/tasks/{task}/comments/{commentid}` | `patch-task-comments-read` | Update a comment of a task (partial) |
| PUT | `/tasks/{task}/comments/{commentid}` | `task-comments-update` | Update a comment of a task |
| PUT | `/tasks/{task}/position` | `tasks-position-update` | Set a task's position in a view |
| POST | `/tasks/{task}/relations` | `tasks-relations-create` | Create a task relation |
| DELETE | `/tasks/{task}/relations/{relationKind}/{otherTask}` | `tasks-relations-delete` | Delete a task relation |
| PUT | `/tasks/bulk` | `tasks-bulk-update` | Bulk update tasks |
| GET | `/teams` | `teams-list` | List teams |
| POST | `/teams` | `teams-create` | Create a team |
| DELETE | `/teams/{id}` | `teams-delete` | Delete a team |
| GET | `/teams/{id}` | `teams-read` | Get a team |
| PATCH | `/teams/{id}` | `patch-teams-read` | Update a team (partial) |
| PUT | `/teams/{id}` | `teams-update` | Update a team |
| POST | `/teams/{team}/members` | `teams-members-add` | Add a member to a team |
| DELETE | `/teams/{team}/members/{user}` | `teams-members-remove` | Remove a member from a team |
| POST | `/teams/{team}/members/{user}/admin` | `teams-members-toggle-admin` | Toggle a team member's admin status |
| GET | `/time-entries` | `time-entries-list` | List time entries |
| POST | `/time-entries` | `time-entries-create` | Create a time entry |
| DELETE | `/time-entries/{id}` | `time-entries-delete` | Delete a time entry |
| GET | `/time-entries/{id}` | `time-entries-read` | Get a time entry |
| PATCH | `/time-entries/{id}` | `patch-time-entries-read` | Update a time entry (partial) |
| PUT | `/time-entries/{id}` | `time-entries-update` | Update a time entry |
| POST | `/time-entries/timer/stop` | `time-entries-timer-stop` | Stop the running timer |
| GET | `/token/test` | `token-test` | Test a token |
| POST | `/token/test` | `token-check` | Check a token |
| GET | `/tokens` | `tokens-list` | List api tokens |
| POST | `/tokens` | `tokens-create` | Create an api token |
| DELETE | `/tokens/{id}` | `tokens-delete` | Delete an api token |
| GET | `/user` | `user-show` | Get the current user |
| GET | `/user/bots` | `bots-list` | List bot users |
| POST | `/user/bots` | `bots-create` | Create a bot user |
| DELETE | `/user/bots/{bot}` | `bots-delete` | Delete a bot user |
| GET | `/user/bots/{bot}` | `bots-read` | Get a bot user |
| PATCH | `/user/bots/{bot}` | `patch-bots-read` | Update a bot user (partial) |
| PUT | `/user/bots/{bot}` | `bots-update` | Update a bot user |
| POST | `/user/confirm` | `auth-confirm-email` | Confirm an email address |
| POST | `/user/deletion/cancel` | `user-deletion-cancel` | Cancel account deletion |
| POST | `/user/deletion/confirm` | `user-deletion-confirm` | Confirm account deletion |
| POST | `/user/deletion/request` | `user-deletion-request` | Request account deletion |
| GET | `/user/export` | `user-export-status` | Get the current data export |
| POST | `/user/export/download` | `user-export-download` | Download the data export |
| POST | `/user/export/request` | `user-export-request` | Request a data export |
| POST | `/user/password` | `user-change-password` | Change the current user's password |
| POST | `/user/password/reset` | `auth-password-reset` | Reset a password |
| POST | `/user/password/token` | `auth-password-token` | Request a password reset token |
| GET | `/user/sessions` | `sessions-list` | List sessions |
| DELETE | `/user/sessions/{session}` | `sessions-delete` | Delete a session |
| PUT | `/user/settings/avatar` | `user-avatar-upload` | Upload your avatar |
| GET | `/user/settings/avatar/provider` | `user-get-avatar-provider` | Get the current user's avatar provider |
| PATCH | `/user/settings/avatar/provider` | `patch-user-get-avatar-provider` | Set the current user's avatar provider (partial) |
| PUT | `/user/settings/avatar/provider` | `user-set-avatar-provider` | Set the current user's avatar provider |
| DELETE | `/user/settings/email` | `user-cancel-email-update` | Cancel a pending email change |
| PUT | `/user/settings/email` | `user-update-email` | Update the current user's email address |
| POST | `/user/settings/email/resend` | `user-resend-email-confirmation` | Resend the confirmation mail for a pending email change |
| PUT | `/user/settings/general` | `user-update-settings` | Update the current user's general settings |
| GET | `/user/settings/token/caldav` | `caldav-tokens-list` | List CalDAV tokens |
| POST | `/user/settings/token/caldav` | `caldav-tokens-create` | Generate a CalDAV token |
| DELETE | `/user/settings/token/caldav/{id}` | `caldav-tokens-delete` | Delete a CalDAV token |
| GET | `/user/settings/totp` | `totp-get` | Get totp status |
| POST | `/user/settings/totp/disable` | `totp-disable` | Disable totp |
| POST | `/user/settings/totp/enable` | `totp-enable` | Enable totp |
| POST | `/user/settings/totp/enroll` | `totp-enroll` | Enroll into totp |
| GET | `/user/settings/totp/qrcode` | `totp-qrcode` | Get the totp enrollment qr code |
| GET | `/user/settings/webhooks` | `user-webhooks-list` | List the current user's webhooks |
| POST | `/user/settings/webhooks` | `user-webhooks-create` | Create a webhook for the current user |
| DELETE | `/user/settings/webhooks/{webhook}` | `user-webhooks-delete` | Delete a user webhook |
| PUT | `/user/settings/webhooks/{webhook}` | `user-webhooks-update` | Update a user webhook's events |
| GET | `/user/settings/webhooks/events` | `user-webhooks-events` | List available user-directed webhook events |
| GET | `/user/timezones` | `user-timezones` | List available time zones |
| POST | `/user/token` | `token-renew` | Renew a link-share token |
| POST | `/user/token/refresh` | `auth-refresh-token` | Refresh user token |
| GET | `/users` | `users-search` | Search users |
| GET | `/webhooks/events` | `webhooks-events-list` | List available webhook events |

## Schemas

| Schema | Properties |
| --- | --- |
| `AdminIsAdminPatchBody` | $schema, is_admin |
| `AdminOwnerPatchBody` | $schema, owner_id |
| `AdminSetPasswordBody` | $schema, new_password |
| `AdminStatusPatchBody` | $schema, status |
| `AdminUser` | $schema, auth_provider, bot_owner_id, created, email, id, is_admin, issuer, name, status, subject, updated, username |
| `APIToken` | $schema, created, expires_at, id, owner_id, permissions, title, token |
| `AttachmentUploadError` | code, message |
| `AttachmentUploadResult` | $schema, errors, success |
| `Auth-link-shareRequest` | $schema, password |
| `AuthInfo` | ldap, local, openid_connect |
| `AuthorizeRequest` | $schema, client_id, code_challenge, code_challenge_method, redirect_uri, response_type, state |
| `AuthorizeResponse` | $schema, code, redirect_uri, state |
| `AuthTokenBodyBody` | $schema, token |
| `BotUser` | $schema, bot_owner_id, created, email, id, name, status, updated, username |
| `BotUserReadBody` | $schema, bot_owner_id, created, email, id, max_permission, name, status, updated, username |
| `Bucket` | $schema, count, created, created_by, id, limit, position, project_view_id, tasks, title, updated |
| `BucketsWithTasksBodyBody` | $schema, items, total |
| `BulkAssignees` | $schema, assignees |
| `BulkTask` | $schema, fields, task_ids, tasks, values |
| `BulkTaskCreation` | $schema, tasks |
| `ColumnMapping` | attribute, column_index, column_name |
| `CreateUserBody` | $schema, email, is_admin, language, name, password, skip_email_confirm, username |
| `DatabaseNotification` | created, id, name, notification, read_at |
| `DatabaseNotifications` | $schema, created, id, name, notification, read, read_at |
| `DetectionResult` | $schema, columns, date_format, delimiter, preview_rows, quote_char, suggested_mapping |
| `EmailConfirm` | $schema, token |
| `ErrorDetail` | location, message, value |
| `File` | created, id, mime, name, size |
| `HealthBodyBody` | $schema, openid_providers, status |
| `Info` | expires_at, features, instance_id, last_check_failed, licensed, max_users, validated_at |
| `JsonPatchOp` | from, op, path, value |
| `Label` | $schema, created, created_by, description, hex_color, id, title, updated |
| `LabelReadBody` | $schema, created, created_by, description, hex_color, id, max_permission, title, updated |
| `LabelTask` | $schema, created, label_id |
| `LabelTaskBulk` | $schema, labels |
| `LabelWithTaskID` | created, created_by, description, hex_color, id, title, updated |
| `LdapAuthInfo` | enabled |
| `LegalInfo` | imprint_url, privacy_policy_url |
| `LinkShareReadBody` | $schema, created, hash, id, max_permission, name, password, permission, shared_by, sharing_type, updated |
| `LinkShareToken` | $schema, created, hash, id, name, password, permission, project_id, shared_by, sharing_type, token, updated |
| `LinkSharing` | $schema, created, hash, id, name, password, permission, shared_by, sharing_type, updated |
| `LocalAuthInfo` | enabled, registration_enabled |
| `Login` | $schema, long_token, password, totp_passcode, username |
| `LogoutBodyBody` | $schema, message, oidc_logout_url |
| `MarkAllReadBodyBody` | $schema, message |
| `Message` | $schema, message |
| `MessageBodyBody` | $schema, message |
| `MigrationCredentialsBody` | $schema, password, token, url, username |
| `MigrationStartedBodyBody` | $schema, message |
| `OpenIDAuthInfo` | enabled, providers |
| `Overview` | $schema, license, projects, shares, tasks, teams, users |
| `PaginatedAdminUser` | $schema, items, page, per_page, total, total_pages |
| `PaginatedAPIToken` | $schema, items, page, per_page, total, total_pages |
| `PaginatedBotUser` | $schema, items, page, per_page, total, total_pages |
| `PaginatedBucket` | $schema, items, page, per_page, total, total_pages |
| `PaginatedDatabaseNotification` | $schema, items, page, per_page, total, total_pages |
| `PaginatedLabelWithTaskID` | $schema, items, page, per_page, total, total_pages |
| `PaginatedLinkSharing` | $schema, items, page, per_page, total, total_pages |
| `PaginatedProject` | $schema, items, page, per_page, total, total_pages |
| `PaginatedProjectView` | $schema, items, page, per_page, total, total_pages |
| `PaginatedSession` | $schema, items, page, per_page, total, total_pages |
| `PaginatedTask` | $schema, items, page, per_page, total, total_pages |
| `PaginatedTaskAttachment` | $schema, items, page, per_page, total, total_pages |
| `PaginatedTaskComment` | $schema, items, page, per_page, total, total_pages |
| `PaginatedTeam` | $schema, items, page, per_page, total, total_pages |
| `PaginatedTeamWithPermission` | $schema, items, page, per_page, total, total_pages |
| `PaginatedTimeEntry` | $schema, items, page, per_page, total, total_pages |
| `PaginatedToken` | $schema, items, page, per_page, total, total_pages |
| `PaginatedUser` | $schema, items, page, per_page, total, total_pages |
| `PaginatedUserWithPermission` | $schema, items, page, per_page, total, total_pages |
| `PaginatedWebhook` | $schema, items, page, per_page, total, total_pages |
| `PasswordReset` | $schema, new_password, token |
| `PasswordTokenRequest` | $schema, email |
| `PreviewResult` | $schema, tasks, total_rows |
| `PreviewTask` | description, done, due_date, end_date, labels, priority, project, start_date, title |
| `Project` | $schema, background_blur_hash, background_information, created, description, hex_color, id, identifier, is_archived, is_favorite, max_permission, owner, parent_project_id, position, subscription, title, updated, views |
| `ProjectDuplicate` | $schema, duplicate_shares, duplicated_project, parent_project_id |
| `ProjectReadBody` | $schema, background_blur_hash, background_information, created, description, hex_color, id, identifier, is_archived, is_favorite, max_permission, owner, parent_project_id, position, subscription, title, updated, views |
| `ProjectUser` | $schema, created, id, permission, updated, username |
| `ProjectView` | $schema, bucket_configuration, bucket_configuration_mode, created, default_bucket_id, done_bucket_id, filter, id, position, project_id, title, updated, view_kind |
| `ProjectViewBucketConfiguration` | filter, title |
| `ProjectViewReadBody` | $schema, bucket_configuration, bucket_configuration_mode, created, default_bucket_id, done_bucket_id, filter, id, max_permission, position, project_id, title, updated, view_kind |
| `Provider` | auth_url, client_id, email_fallback, force_user_info, key, logout_url, name, scope, username_fallback |
| `ProviderStatus` | available, key |
| `Reaction` | $schema, created, user, value |
| `RenewTokenBodyBody` | $schema, token |
| `RouteDetail` | method, path |
| `SavedFilter` | $schema, created, description, filters, id, is_favorite, owner, title, updated |
| `SavedFilterReadBody` | $schema, created, description, filters, id, is_favorite, max_permission, owner, title, updated |
| `Session` | created, device_info, id, ip_address, last_active, refresh_token |
| `ShareCounts` | link_shares, team_shares, user_shares |
| `Status` | $schema, finished_at, id, migrator_name, started_at |
| `Subscription` | $schema, created, entity, entity_id, id |
| `Task` | $schema, assignees, attachments, bucket_id, buckets, comment_count, comments, cover_image_attachment_id, created, created_by, deleted_at, description, done, done_at, due_date, end_date, hex_color, id, identifier, index, is_favorite, is_unread, labels, percent_done, position, priority, project_id, reactions, related_tasks, reminders, repeat_after, repeat_mode, start_date, subscription, time_entries_count, title, updated |
| `TaskAssginee` | $schema, created, user_id |
| `TaskAttachment` | created, created_by, file, id, task_id |
| `TaskBucket` | $schema, bucket, bucket_id, project_view_id, task, task_id |
| `TaskCollection` | filter, filter_include_nulls, order_by, s, sort_by |
| `TaskComment` | $schema, author, comment, created, id, reactions, updated |
| `TaskCommentReadBody` | $schema, author, comment, created, id, max_permission, reactions, updated |
| `TaskDuplicate` | $schema, duplicated_task |
| `TaskPosition` | $schema, position, project_view_id, task_id |
| `TaskReadBodyBody` | $schema, message |
| `TaskReadOneBody` | $schema, assignees, attachments, bucket_id, buckets, comment_count, comments, cover_image_attachment_id, created, created_by, deleted_at, description, done, done_at, due_date, end_date, hex_color, id, identifier, index, is_favorite, is_unread, labels, max_permission, percent_done, position, priority, project_id, reactions, related_tasks, reminders, repeat_after, repeat_mode, start_date, subscription, time_entries_count, title, updated |
| `TaskRelation` | $schema, created, created_by, other_task_id, relation_kind, task_id |
| `TaskReminder` | relative_period, relative_to, reminder |
| `Team` | $schema, created, created_by, description, external_id, id, is_public, members, name, updated |
| `TeamMember` | $schema, admin, created, id, username |
| `TeamProject` | $schema, created, id, permission, team_id, updated |
| `TeamReadBody` | $schema, created, created_by, description, external_id, id, is_public, max_permission, members, name, updated |
| `TeamUser` | admin, bot_owner_id, created, email, id, name, updated, username |
| `TeamWithPermission` | created, created_by, description, external_id, id, is_public, members, name, permission, updated |
| `TimeEntry` | $schema, comment, created, end_time, id, project_id, start_time, task_id, updated, user_id |
| `TimeEntryReadBody` | $schema, comment, created, end_time, id, max_permission, project_id, start_time, task_id, updated, user_id |
| `Token` | $schema, created, id, token |
| `TokenRequest` | $schema, client_id, code, code_verifier, grant_type, redirect_uri, refresh_token |
| `TokenResponse` | $schema, access_token, expires_in, refresh_token, token_type |
| `TokenTestBodyBody` | $schema, message |
| `TOTP` | $schema, enabled, secret, url |
| `TotpDisableBodyBody` | $schema, password |
| `TotpEnableBodyBody` | $schema, passcode |
| `User` | $schema, bot_owner_id, created, email, id, name, updated, username |
| `User-change-passwordRequest` | $schema, new_password, old_password |
| `User-update-emailRequest` | $schema, new_email, password |
| `UserActionMessageBody` | $schema, message |
| `UserAvatarProviderBody` | $schema, avatar_provider |
| `UserDeletionConfirmBodyBody` | $schema, token |
| `UserDeletionPasswordBodyBody` | $schema, password |
| `UserExportPasswordBodyBody` | $schema, password |
| `UserExportStatus` | $schema, created, expires, id, size |
| `UserGeneralSettings` | $schema, default_project_id, discoverable_by_email, discoverable_by_name, email_reminders_enabled, extra_settings_links, frontend_settings, language, name, overdue_tasks_reminders_enabled, overdue_tasks_reminders_time, timezone, week_start |
| `UserInfoBody` | $schema, auth_provider, bot_owner_id, created, deletion_scheduled_at, email, id, is_admin, is_local_user, name, pending_email, settings, updated, username |
| `UserRegister` | $schema, email, language, password, username |
| `UserWithPermission` | bot_owner_id, created, email, id, name, permission, updated, username |
| `VikunjaErrorModel` | $schema, code, detail, errors, i18n_params, instance, status, title, type |
| `VikunjaInfos` | $schema, allow_icon_changes, auth, available_migrators, caldav_enabled, concurrent_writes, demo_mode_enabled, email_reminders_enabled, enabled_background_providers, enabled_pro_features, frontend_url, legal, link_sharing_enabled, max_file_size, max_items_per_page, motd, public_teams_enabled, task_attachments_enabled, task_comments_enabled, totp_enabled, user_deletion_enabled, version, webhooks_enabled |
| `Webhook` | $schema, basic_auth_password, basic_auth_user, created, created_by, events, id, project_id, secret, target_url, updated, user_id |
