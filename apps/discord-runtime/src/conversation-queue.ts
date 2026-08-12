/** A unit of serialized work bound to a container. */
type Task = () => Promise<void>;

/** Maximum number of pending tasks per container before the oldest is dropped. */
const MAX_QUEUE_SIZE = 10;

/**
 * Per-container serial task queue. At most one task runs per container at a
 * time; subsequent tasks wait. When a container's queue is full, the oldest
 * pending task is dropped for backpressure (matching the bot-worker concurrency
 * config: `maxQueueSize: 10`, `onQueueFull: "drop-oldest"`).
 */
export class ConversationQueue {
  private readonly queues = new Map<string, Task[]>();
  private readonly running = new Set<string>();

  /**
   * Enqueue a task for a container. Runs immediately if the container is idle,
   * otherwise queues it behind any pending work. Overflow drops the oldest
   * pending task and logs the event.
   */
  enqueue(containerId: string, task: Task): void {
    let queue = this.queues.get(containerId);
    if (!queue) {
      queue = [];
      this.queues.set(containerId, queue);
    }

    queue.push(task);
    if (queue.length > MAX_QUEUE_SIZE) {
      queue.shift();
      console.log(
        JSON.stringify({
          event: "queue_overflow_drop_oldest",
          containerId,
          queueSize: queue.length,
        }),
      );
    }

    void this.drain(containerId);
  }

  /** Serially run all tasks for a container until its queue is drained. */
  private async drain(containerId: string): Promise<void> {
    if (this.running.has(containerId)) return;
    this.running.add(containerId);
    try {
      const queue = this.queues.get(containerId);
      if (!queue) return;
      while (queue.length > 0) {
        const task = queue.shift()!;
        try {
          await task();
        } catch (error) {
          console.log(
            JSON.stringify({
              event: "queue_task_error",
              containerId,
              error: String(error),
            }),
          );
        }
      }
    } finally {
      this.running.delete(containerId);
      this.queues.delete(containerId);
    }
  }
}
