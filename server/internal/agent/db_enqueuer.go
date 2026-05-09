package agent

import (
	"context"

	"github.com/airborne23/folio/server/internal/service"
)

// DBTaskEnqueuer delegates channel-context task enqueues to TaskService so the
// daemon wakeup signal (notifyTaskAvailable) and the task:queued realtime
// broadcast fire alongside the DB insert. Without delegating to TaskService,
// channel @mention tasks would sit in the queue for up to the daemon's full
// poll interval (~30s) before being claimed.
type DBTaskEnqueuer struct {
	taskSvc *service.TaskService
}

// NewDBTaskEnqueuer returns an enqueuer backed by an existing TaskService.
func NewDBTaskEnqueuer(taskSvc *service.TaskService) *DBTaskEnqueuer {
	return &DBTaskEnqueuer{taskSvc: taskSvc}
}

// Enqueue inserts one agent_task_queue row for a channel-message dispatch and
// fires the standard "task queued" broadcast + daemon wakeup notification.
// Agent-alive / has-runtime validation lives inside TaskService.EnqueueChannelTask.
func (e *DBTaskEnqueuer) Enqueue(ctx context.Context, p EnqueueParams) error {
	_, err := e.taskSvc.EnqueueChannelTask(ctx, service.EnqueueChannelTaskParams{
		AgentID:   p.AgentID,
		ChannelID: p.ChannelID,
		Context:   p.Context,
		Priority:  p.Priority,
	})
	return err
}
