-- Add index to assignment_submissions.status for optimization
CREATE INDEX `assignment_submissions_status_idx` ON `assignment_submissions`(`status`);
