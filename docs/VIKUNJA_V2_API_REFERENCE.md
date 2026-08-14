# Vikunja V2 API Reference

This file is generated from the sanitized local OpenAPI snapshot.

- Raw specification: [`vikunja-v2-openapi.json`](vikunja-v2-openapi.json)
- Upstream API documentation: https://vikunja.io/docs/api-documentation/
- Minimum supported official release: https://github.com/go-vikunja/vikunja/releases/tag/v2.4.0
- API generation: live Vikunja 2.5.0 service
- Snapshot date: 2026-08-14
- OpenAPI version: 3.1.0
- API title: Vikunja API
- API version: v2.5.0

Vikunja generates this OpenAPI document at runtime. The checked-in copy is
the latest-only HTTP authority for this MCP and must be refreshed when the
minimum supported Vikunja release changes. Instance URLs are replaced with
`https://vikunja.example.com`; no credential is stored.

## Operations

| Method | Path | Operation | Summary |
| --- | --- | --- | --- |
| GET | `/admin/overview` | `admin-overview` | Admin overview |
| GET | `/admin/projects` | `admin-projects-list` | List all projects (admin) |
| PATCH | `/admin/projects/{id}/owner` | `admin-projects-patch-owner` | Reassign a project's owner (admin) |
| POST | `/admin/users` | `admin-users-create` | Create a user (admin) |
| DELETE | `/admin/users/{id}` | `admin-users-delete` | Delete a user (admin) |
| PATCH | `/admin/users/{id}/admin` | `admin-users-patch-admin` | Promote or demote a user (admin) |
| PATCH | `/admin/users/{id}/password` | `admin-users-set-password` | Set a user's password (admin) |
| POST | `/admin/users/{id}/password-reset-email` | `admin-users-password-reset-email` | Send a password-reset email (admin) |
| PATCH | `/admin/users/{id}/status` | `admin-users-patch-status` | Set a user's status (admin) |
| GET | `/avatar/{username}` | `avatar-get` | Get a user's avatar |
| POST | `/filters` | `filters-create` | Create a saved filter |
| GET | `/filters/{filter}` | `filters-read` | Get a saved filter |
| PUT | `/filters/{filter}` | `filters-update` | Update a saved filter |
| PATCH | `/filters/{filter}` | `patch-filters-read` | Update a saved filter (partial) |
| DELETE | `/filters/{filter}` | `filters-delete` | Delete a saved filter |
| GET | `/health` | `health` | Healthcheck |
| GET | `/info` | `info` | Instance info |
| GET | `/labels` | `labels-list` | List labels |
| POST | `/labels` | `labels-create` | Create a label |
| GET | `/labels/{id}` | `labels-read` | Get a label |
| PUT | `/labels/{id}` | `labels-update` | Update a label |
| PATCH | `/labels/{id}` | `patch-labels-read` | Update a label (partial) |
| DELETE | `/labels/{id}` | `labels-delete` | Delete a label |
| POST | `/login` | `auth-login` | Login |
| POST | `/logout` | `auth-logout` | Logout |
| POST | `/migration/csv/detect` | `migration-csv-detect` | Detect a CSV file's structure |
| POST | `/migration/csv/migrate` | `migration-csv-migrate` | Import a CSV file |
| POST | `/migration/csv/preview` | `migration-csv-preview` | Preview a CSV import |
| GET | `/migration/csv/status` | `migration-csv-status` | Get the CSV migration status |
| POST | `/migration/ticktick/migrate` | `migration-ticktick-migrate` | Migrate from ticktick |
| GET | `/migration/ticktick/status` | `migration-ticktick-status` | Get the migration status for ticktick |
| POST | `/migration/vikunja-file/migrate` | `migration-vikunja-file-migrate` | Migrate from vikunja-file |
| GET | `/migration/vikunja-file/status` | `migration-vikunja-file-status` | Get the migration status for vikunja-file |
| POST | `/migration/wekan/migrate` | `migration-wekan-migrate` | Migrate from wekan |
| GET | `/migration/wekan/status` | `migration-wekan-status` | Get the migration status for wekan |
| GET | `/notifications` | `notifications-list` | List notifications |
| POST | `/notifications` | `notifications-mark-all-read` | Mark all notifications as read |
| GET | `/notifications.atom` | `notifications-atom-feed` | Notifications Atom feed |
| PUT | `/notifications/{notificationid}` | `notifications-mark-read` | Mark a notification as (un-)read |
| POST | `/oauth/authorize` | `oauth-authorize` | OAuth 2.0 authorize endpoint |
| POST | `/oauth/token` | `oauth-token` | OAuth 2.0 token endpoint |
| GET | `/projects` | `projects-list` | List projects |
| POST | `/projects` | `projects-create` | Create a project |
| GET | `/projects/{id}` | `projects-read` | Get a project |
| PUT | `/projects/{id}` | `projects-update` | Update a project |
| PATCH | `/projects/{id}` | `patch-projects-read` | Update a project (partial) |
| DELETE | `/projects/{id}` | `projects-delete` | Delete a project |
| GET | `/projects/{project_id}/time-entries` | `project-time-entries-list` | List a project's time entries |
| POST | `/projects/{projectid}/duplicate` | `projects-duplicate` | Duplicate a project |
| GET | `/projects/{project}/background` | `projects-background-get` | Get a project background |
| DELETE | `/projects/{project}/background` | `projects-background-delete` | Remove a project background |
| PUT | `/projects/{project}/backgrounds/upload` | `projects-background-upload` | Upload a project background |
| GET | `/projects/{project}/shares` | `shares-list` | List the link shares of a project |
| POST | `/projects/{project}/shares` | `shares-create` | Share a project via link |
| GET | `/projects/{project}/shares/{share}` | `shares-read` | Get a single link share of a project |
| DELETE | `/projects/{project}/shares/{share}` | `shares-delete` | Remove a link share from a project |
| GET | `/projects/{project}/tasks` | `project-tasks-list` | List tasks in a project |
| POST | `/projects/{project}/tasks` | `tasks-create` | Create a task |
| POST | `/projects/{project}/tasks/bulk` | `tasks-bulk-create` | Create tasks atomically in a project |
| GET | `/projects/{project}/tasks/by-index/{index}` | `tasks-read-by-index` | Get a task by its project index |
| GET | `/projects/{project}/teams` | `project-teams-list` | List the teams a project is shared with |
| POST | `/projects/{project}/teams` | `project-teams-create` | Share a project with a team |
| PUT | `/projects/{project}/teams/{team}` | `project-teams-update` | Update a team's permission on a project |
| DELETE | `/projects/{project}/teams/{team}` | `project-teams-delete` | Remove a team from a project |
| GET | `/projects/{project}/users` | `project-users-list` | List the users a project is shared with |
| POST | `/projects/{project}/users` | `project-users-create` | Share a project with a user |
| GET | `/projects/{project}/users/search` | `projects-users-search` | Search users with access to a project |
| PUT | `/projects/{project}/users/{user}` | `project-users-update` | Update a user's permission on a project |
| DELETE | `/projects/{project}/users/{user}` | `project-users-delete` | Remove a user's access to a project |
| GET | `/projects/{project}/views` | `project-views-list` | List the views of a project |
| POST | `/projects/{project}/views` | `project-views-create` | Create a view in a project |
| GET | `/projects/{project}/views/{view}` | `project-views-read` | Get a single view of a project |
| PUT | `/projects/{project}/views/{view}` | `project-views-update` | Update a view of a project |
| PATCH | `/projects/{project}/views/{view}` | `patch-project-views-read` | Update a view of a project (partial) |
| DELETE | `/projects/{project}/views/{view}` | `project-views-delete` | Delete a view of a project |
| GET | `/projects/{project}/views/{view}/buckets` | `buckets-list` | List the buckets of a kanban view |
| POST | `/projects/{project}/views/{view}/buckets` | `buckets-create` | Create a bucket in a kanban view |
| GET | `/projects/{project}/views/{view}/buckets/tasks` | `project-view-buckets-tasks-list` | List a kanban view's buckets with their tasks |
| PUT | `/projects/{project}/views/{view}/buckets/{bucket}` | `buckets-update` | Update a bucket of a kanban view |
| DELETE | `/projects/{project}/views/{view}/buckets/{bucket}` | `buckets-delete` | Delete a bucket of a kanban view |
| PUT | `/projects/{project}/views/{view}/buckets/{bucket}/tasks` | `task-bucket-update` | Place a task in a kanban bucket |
| GET | `/projects/{project}/views/{view}/tasks` | `project-view-tasks-list` | List tasks in a project view |
| GET | `/projects/{project}/webhooks` | `webhooks-list` | List a project's webhooks |
| POST | `/projects/{project}/webhooks` | `webhooks-create` | Create a webhook target in a project |
| PUT | `/projects/{project}/webhooks/{webhook}` | `webhooks-update` | Update a webhook target's events |
| DELETE | `/projects/{project}/webhooks/{webhook}` | `webhooks-delete` | Delete a webhook target |
| POST | `/register` | `auth-register` | Register |
| GET | `/routes` | `token-routes` | List API token routes |
| POST | `/shares/{share}/auth` | `auth-link-share` | Get an auth token for a link share |
| POST | `/subscriptions/{entity}/{entityID}` | `subscriptions-create` | Subscribe to an entity |
| DELETE | `/subscriptions/{entity}/{entityID}` | `subscriptions-delete` | Unsubscribe from an entity |
| GET | `/tasks` | `tasks-list` | List tasks across all projects |
| PUT | `/tasks/bulk` | `tasks-bulk-update` | Bulk update tasks |
| GET | `/tasks/{projecttask}` | `tasks-read` | Get a task |
| PUT | `/tasks/{projecttask}` | `tasks-update` | Update a task |
| PATCH | `/tasks/{projecttask}` | `patch-tasks-read` | Update a task (partial) |
| DELETE | `/tasks/{projecttask}` | `tasks-delete` | Delete a task |
| GET | `/tasks/{projecttask}/assignees` | `task-assignees-list` | List the assignees of a task |
| POST | `/tasks/{projecttask}/assignees` | `task-assignees-create` | Assign a user to a task |
| PUT | `/tasks/{projecttask}/assignees/bulk` | `task-assignees-bulk` | Replace all assignees of a task |
| DELETE | `/tasks/{projecttask}/assignees/{user}` | `task-assignees-delete` | Remove an assignee from a task |
| POST | `/tasks/{projecttask}/duplicate` | `tasks-duplicate` | Duplicate a task |
| GET | `/tasks/{projecttask}/labels` | `task-labels-list` | List the labels on a task |
| POST | `/tasks/{projecttask}/labels` | `task-labels-create` | Add a label to a task |
| PUT | `/tasks/{projecttask}/labels/bulk` | `task-labels-bulk-replace` | Replace all labels on a task |
| DELETE | `/tasks/{projecttask}/labels/{label}` | `task-labels-delete` | Remove a label from a task |
| PUT | `/tasks/{projecttask}/read` | `tasks-mark-read` | Mark a task as read |
| GET | `/tasks/{task_id}/time-entries` | `task-time-entries-list` | List a task's time entries |
| GET | `/tasks/{task}/attachments` | `task-attachments-list` | List a task's attachments |
| POST | `/tasks/{task}/attachments` | `task-attachments-upload` | Upload task attachments |
| GET | `/tasks/{task}/attachments/{attachment}` | `task-attachments-download` | Download a task attachment |
| DELETE | `/tasks/{task}/attachments/{attachment}` | `task-attachments-delete` | Delete a task attachment |
| GET | `/tasks/{task}/comments` | `task-comments-list` | List the comments of a task |
| POST | `/tasks/{task}/comments` | `task-comments-create` | Create a comment on a task |
| GET | `/tasks/{task}/comments/{commentid}` | `task-comments-read` | Get a single comment of a task |
| PUT | `/tasks/{task}/comments/{commentid}` | `task-comments-update` | Update a comment of a task |
| PATCH | `/tasks/{task}/comments/{commentid}` | `patch-task-comments-read` | Update a comment of a task (partial) |
| DELETE | `/tasks/{task}/comments/{commentid}` | `task-comments-delete` | Delete a comment of a task |
| PUT | `/tasks/{task}/position` | `tasks-position-update` | Set a task's position in a view |
| POST | `/tasks/{task}/relations` | `tasks-relations-create` | Create a task relation |
| DELETE | `/tasks/{task}/relations/{relationKind}/{otherTask}` | `tasks-relations-delete` | Delete a task relation |
| GET | `/teams` | `teams-list` | List teams |
| POST | `/teams` | `teams-create` | Create a team |
| GET | `/teams/{id}` | `teams-read` | Get a team |
| PUT | `/teams/{id}` | `teams-update` | Update a team |
| PATCH | `/teams/{id}` | `patch-teams-read` | Update a team (partial) |
| DELETE | `/teams/{id}` | `teams-delete` | Delete a team |
| POST | `/teams/{team}/members` | `teams-members-add` | Add a member to a team |
| DELETE | `/teams/{team}/members/{user}` | `teams-members-remove` | Remove a member from a team |
| POST | `/teams/{team}/members/{user}/admin` | `teams-members-toggle-admin` | Toggle a team member's admin status |
| GET | `/time-entries` | `time-entries-list` | List time entries |
| POST | `/time-entries` | `time-entries-create` | Create a time entry |
| POST | `/time-entries/timer/stop` | `time-entries-timer-stop` | Stop the running timer |
| GET | `/time-entries/{id}` | `time-entries-read` | Get a time entry |
| PUT | `/time-entries/{id}` | `time-entries-update` | Update a time entry |
| PATCH | `/time-entries/{id}` | `patch-time-entries-read` | Update a time entry (partial) |
| DELETE | `/time-entries/{id}` | `time-entries-delete` | Delete a time entry |
| GET | `/token/test` | `token-test` | Test a token |
| POST | `/token/test` | `token-check` | Check a token |
| GET | `/tokens` | `tokens-list` | List api tokens |
| POST | `/tokens` | `tokens-create` | Create an api token |
| DELETE | `/tokens/{id}` | `tokens-delete` | Delete an api token |
| GET | `/user` | `user-show` | Get the current user |
| GET | `/user/bots` | `bots-list` | List bot users |
| POST | `/user/bots` | `bots-create` | Create a bot user |
| GET | `/user/bots/{bot}` | `bots-read` | Get a bot user |
| PUT | `/user/bots/{bot}` | `bots-update` | Update a bot user |
| PATCH | `/user/bots/{bot}` | `patch-bots-read` | Update a bot user (partial) |
| DELETE | `/user/bots/{bot}` | `bots-delete` | Delete a bot user |
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
| PUT | `/user/settings/avatar/provider` | `user-set-avatar-provider` | Set the current user's avatar provider |
| PATCH | `/user/settings/avatar/provider` | `patch-user-get-avatar-provider` | Set the current user's avatar provider (partial) |
| PUT | `/user/settings/email` | `user-update-email` | Update the current user's email address |
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
| GET | `/user/settings/webhooks/events` | `user-webhooks-events` | List available user-directed webhook events |
| PUT | `/user/settings/webhooks/{webhook}` | `user-webhooks-update` | Update a user webhook's events |
| DELETE | `/user/settings/webhooks/{webhook}` | `user-webhooks-delete` | Delete a user webhook |
| GET | `/user/timezones` | `user-timezones` | List available time zones |
| POST | `/user/token` | `token-renew` | Renew a link-share token |
| POST | `/user/token/refresh` | `auth-refresh-token` | Refresh user token |
| GET | `/users` | `users-search` | Search users |
| GET | `/webhooks/events` | `webhooks-events-list` | List available webhook events |
| GET | `/{entitykind}/{entityid}/reactions` | `reactions-list` | List reactions for an entity |
| POST | `/{entitykind}/{entityid}/reactions` | `reactions-create` | React to an entity |
| POST | `/{entitykind}/{entityid}/reactions/delete` | `reactions-delete` | Remove a reaction from an entity |

## Component Schemas

- `APIToken`
- `AdminIsAdminPatchBody`
- `AdminOwnerPatchBody`
- `AdminSetPasswordBody`
- `AdminStatusPatchBody`
- `AdminUser`
- `AttachmentUploadError`
- `AttachmentUploadResult`
- `Auth-link-shareRequest`
- `AuthInfo`
- `AuthTokenBodyBody`
- `AuthorizeRequest`
- `AuthorizeResponse`
- `BotUser`
- `BotUserReadBody`
- `Bucket`
- `BucketsWithTasksBodyBody`
- `BulkAssignees`
- `BulkTask`
- `ColumnMapping`
- `CreateUserBody`
- `DatabaseNotification`
- `DatabaseNotifications`
- `DetectionResult`
- `EmailConfirm`
- `ErrorDetail`
- `File`
- `HealthBodyBody`
- `Info`
- `JsonPatchOp`
- `Label`
- `LabelReadBody`
- `LabelTask`
- `LabelTaskBulk`
- `LabelWithTaskID`
- `LdapAuthInfo`
- `LegalInfo`
- `LinkShareReadBody`
- `LinkShareToken`
- `LinkSharing`
- `LocalAuthInfo`
- `Login`
- `LogoutBodyBody`
- `MarkAllReadBodyBody`
- `Message`
- `MessageBodyBody`
- `MigrationStartedBodyBody`
- `OpenIDAuthInfo`
- `Overview`
- `PaginatedAPIToken`
- `PaginatedBotUser`
- `PaginatedBucket`
- `PaginatedDatabaseNotification`
- `PaginatedLabelWithTaskID`
- `PaginatedLinkSharing`
- `PaginatedProject`
- `PaginatedProjectView`
- `PaginatedSession`
- `PaginatedTask`
- `PaginatedTaskAttachment`
- `PaginatedTaskComment`
- `PaginatedTeam`
- `PaginatedTeamWithPermission`
- `PaginatedTimeEntry`
- `PaginatedToken`
- `PaginatedUser`
- `PaginatedUserWithPermission`
- `PaginatedWebhook`
- `PasswordReset`
- `PasswordTokenRequest`
- `PreviewResult`
- `PreviewTask`
- `Project`
- `ProjectDuplicate`
- `ProjectReadBody`
- `ProjectUser`
- `ProjectView`
- `ProjectViewBucketConfiguration`
- `ProjectViewReadBody`
- `Provider`
- `ProviderStatus`
- `Reaction`
- `RenewTokenBodyBody`
- `RouteDetail`
- `SavedFilter`
- `SavedFilterReadBody`
- `Session`
- `ShareCounts`
- `Status`
- `Subscription`
- `TOTP`
- `Task`
- `TaskAssginee`
- `TaskAttachment`
- `TaskBucket`
- `TaskCollection`
- `TaskComment`
- `TaskCommentReadBody`
- `TaskDuplicate`
- `TaskPosition`
- `TaskReadBodyBody`
- `TaskReadOneBody`
- `TaskRelation`
- `TaskReminder`
- `Team`
- `TeamMember`
- `TeamProject`
- `TeamReadBody`
- `TeamUser`
- `TeamWithPermission`
- `TimeEntry`
- `TimeEntryReadBody`
- `Token`
- `TokenRequest`
- `TokenResponse`
- `TokenTestBodyBody`
- `TotpDisableBodyBody`
- `TotpEnableBodyBody`
- `User`
- `User-change-passwordRequest`
- `User-update-emailRequest`
- `UserActionMessageBody`
- `UserAvatarProviderBody`
- `UserDeletionConfirmBodyBody`
- `UserDeletionPasswordBodyBody`
- `UserExportPasswordBodyBody`
- `UserExportStatus`
- `UserGeneralSettings`
- `UserInfoBody`
- `UserRegister`
- `UserWithPermission`
- `VikunjaErrorModel`
- `VikunjaInfos`
- `Webhook`
