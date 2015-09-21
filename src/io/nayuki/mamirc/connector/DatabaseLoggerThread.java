package io.nayuki.mamirc.connector;

import java.io.File;
import java.util.ArrayDeque;
import java.util.Queue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.Lock;
import java.util.concurrent.locks.ReentrantLock;
import com.almworks.sqlite4java.SQLiteConnection;
import com.almworks.sqlite4java.SQLiteException;
import com.almworks.sqlite4java.SQLiteStatement;
import io.nayuki.mamirc.common.Event;


final class DatabaseLoggerThread extends Thread {
	
	/*---- Fields ----*/
	
	private final MamircConnector master;
	
	// Synchronization
	private final Lock lock;
	private final Condition condAll;      // await() by logger, signal() upon {queue non-empty OR flush request's rising edge OR terminate request's rising edge}
	private final Condition condUrgent;   // await() by logger, signal() upon {flush request's rising edge OR terminate request's rising edge}
	// await() by caller of flushQueue(), signal() by database logger when all queue items at time of flushQueue() call are written and committed to database;
	// no new items can be added while flushQueue() blocks because the MamircConnector global state is blocked
	private final Condition condFlushed;
	
	// Monitor state
	private Queue<Event> queue;
	private boolean flushRequested;
	private boolean terminateRequested;
	
	// Database access
	private final SQLiteConnection database;
	private SQLiteStatement beginTransaction;
	private SQLiteStatement commitTransaction;
	private SQLiteStatement insertEvent;
	
	
	/*---- Constructor ----*/
	
	public DatabaseLoggerThread(MamircConnector master, File file) {
		if (master == null || file == null)
			throw new NullPointerException();
		this.master = master;
		
		lock = new ReentrantLock();
		condAll     = lock.newCondition();
		condUrgent  = lock.newCondition();
		condFlushed = lock.newCondition();
		
		queue = new ArrayDeque<>();
		flushRequested = false;
		terminateRequested = false;
		
		database = new SQLiteConnection(file);
	}
	
	
	/*---- Methods ----*/
	
	public void run() {
		try {
			// Initialize table, prepare statements
			database.open(true);
			database.exec("CREATE TABLE IF NOT EXISTS events(connectionId INTEGER, sequence INTEGER, timestamp INTEGER NOT NULL, type INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(connectionId, sequence))");
			beginTransaction  = database.prepare("BEGIN TRANSACTION");
			commitTransaction = database.prepare("COMMIT TRANSACTION");
			insertEvent       = database.prepare("INSERT INTO events VALUES(?,?,?,?,?)");
			
			// Query for next connection ID
			SQLiteStatement getMaxConId = database.prepare("SELECT max(connectionId) FROM events");
			step(getMaxConId, true);
			if (getMaxConId.columnNull(0))
				master.databaseReady(0);
			else
				master.databaseReady(getMaxConId.columnInt(0) + 1);
			getMaxConId.dispose();
			
			// Process events
			lock.lock();
			try {
				while (processBatchOfEvents());
			} catch (SQLiteException e) {
				e.printStackTrace();
			} finally {
				queue = null;
				lock.unlock();
			}
			
		// Clean up
		} catch (SQLiteException e) {
			e.printStackTrace();
		} catch (InterruptedException e) {
			e.printStackTrace();
		}
		finally {
			beginTransaction.dispose();
			commitTransaction.dispose();
			insertEvent.dispose();
			database.dispose();
		}
	}
	
	
	private static final int GATHER_DATA_DELAY     =  2000;  // In milliseconds
	private static final int DATABASE_COMMIT_DELAY = 10000;  // In milliseconds

	// Must hold 'lock' before and after the method call.
	private boolean processBatchOfEvents() throws SQLiteException, InterruptedException {
		// Wait for something to do
		while (queue.isEmpty() && !flushRequested && !terminateRequested)
			condAll.await();
		
		if (queue.isEmpty()) {
			if (flushRequested)
				throw new IllegalStateException();
			return !terminateRequested;
			
		} else {
			if (flushRequested) {
				// Drain the queue straightforwardly
				step(beginTransaction, false);
				beginTransaction.reset();
				while (!queue.isEmpty())
					insertEventIntoDb(queue.remove());
				step(commitTransaction, false);
				commitTransaction.reset();
				flushRequested = false;
				condFlushed.signal();
				
			} else {
				// Wait to gather quick request-response events
				condUrgent.await(GATHER_DATA_DELAY, TimeUnit.MILLISECONDS);
				
				// Drain the queue without blocking on I/O
				Event[] events = new Event[queue.size()];
				for (int i = 0; i < events.length; i++)
					events[i] = queue.remove();
				if (!queue.isEmpty())
					throw new AssertionError();
				
				// Do all database I/O while allowing other threads to post events
				lock.unlock();
				step(beginTransaction, false);
				beginTransaction.reset();
				for (Event ev : events)
					insertEventIntoDb(ev);
				step(commitTransaction, false);
				commitTransaction.reset();
				lock.lock();
				// At this point, the queue may be non-empty and the flags may have changed
				
				if (!flushRequested)
					condUrgent.await(DATABASE_COMMIT_DELAY, TimeUnit.MILLISECONDS);
			}
			return true;  // Re-evaluate the full situation even if termination is requested
		}
	}
	
	
	private void insertEventIntoDb(Event ev) throws SQLiteException {
		insertEvent.bind(1, ev.connectionId);
		insertEvent.bind(2, ev.sequence);
		insertEvent.bind(3, ev.timestamp);
		insertEvent.bind(4, ev.type.ordinal());
		insertEvent.bind(5, ev.getLine());
		step(insertEvent, false);
		insertEvent.reset();
	}
	
	
	// Should only be called from the connector object.
	public void postEvent(Event event) {
		if (event == null)
			throw new NullPointerException();
		lock.lock();
		queue.add(event);
		condAll.signal();
		lock.unlock();
	}
	
	
	// Synchronously requests all queued events to be committed to the database,
	// blocking until finished. Should only be called from the connector object.
	public void flushQueue() {
		lock.lock();
		if (flushRequested)
			throw new IllegalStateException();
		if (!queue.isEmpty()) {
			flushRequested = true;
			condAll.signal();
			condUrgent.signal();
			do condFlushed.awaitUninterruptibly();
			while (flushRequested);
			if (!queue.isEmpty())
				throw new IllegalStateException();
		}
		lock.unlock();
	}
	
	
	// Asynchronously requests this thread to terminate. Should only be called from the connector object.
	public void terminate() {
		lock.lock();
		terminateRequested = true;
		condAll.signal();
		condUrgent.signal();
		lock.unlock();
	}
	
	
	private static void step(SQLiteStatement stat, boolean expectingResult) throws SQLiteException {
		if (stat.step() != expectingResult)
			throw new AssertionError();
	}
	
}
