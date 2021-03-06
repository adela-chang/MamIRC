/* 
 * MamIRC
 * Copyright (c) Project Nayuki
 * 
 * https://www.nayuki.io/page/mamirc-the-headless-irc-client
 * https://github.com/nayuki/MamIRC
 */

package io.nayuki.mamirc.connector;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.net.InetAddress;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.logging.Level;
import java.util.logging.Logger;
import com.almworks.sqlite4java.SQLiteException;
import io.nayuki.mamirc.common.CleanLine;
import io.nayuki.mamirc.common.BackendConfiguration;
import io.nayuki.mamirc.common.Event;
import io.nayuki.mamirc.common.OutputWriterThread;
import io.nayuki.mamirc.common.Utils;


/* 
 * The MamIRC connector main program class. The main thread creates a new MamircConnector object, launches a handful
 * of worker threads, and returns. Thereafter, the MamircConnector object holds the global state of the application,
 * always accessed with a mutex ('synchronized') from any one of the worker threads.
 */
public final class MamircConnector {
	
	/*---- Stub main program ----*/
	
	public static void main(String[] args) throws IOException, SQLiteException {
		if (args.length != 1) {
			System.err.println("Usage: java io/nayuki/mamirc/connector/MamircConnector BackendConfig.json");
			System.exit(1);
		}
		
		// Prevent sqlite4java module from polluting stderr with debug messages
		Logger.getLogger("com.almworks.sqlite4java").setLevel(Level.OFF);
		
		// Load config and start connector
		File configFile = new File(args[0]);
		BackendConfiguration config = new BackendConfiguration(configFile);
		new MamircConnector(config);
		// The main thread returns, while other threads live on
	}
	
	
	
	/*---- Fields ----*/
	
	// All of these fields are shared global state. Any read/write access
	// must be done while synchronized on this MamircConnector object!
	
	// Connections to remote IRC servers
	private int nextConnectionId;
	private final Map<Integer,ConnectionInfo> serverConnections;
	
	// Ephemeral threads
	private ProcessorReaderThread processorReader;
	private OutputWriterThread processorWriter;
	
	// Singleton threads
	private final DatabaseLoggerThread databaseLogger;
	private final ProcessorListenerThread processorListener;
	private final Thread connectionPinger;
	
	
	
	/*---- Constructor ----*/
	
	// This constructor launches a bunch of worker threads and returns immediately.
	// If initialization failed, the new threads are terminated and an exception is thrown.
	public MamircConnector(BackendConfiguration config) throws IOException, SQLiteException {
		// Initialize some fields
		serverConnections = new HashMap<>();
		processorReader = null;
		processorWriter = null;
		
		// Initialize database logger and get next connection ID
		databaseLogger = new DatabaseLoggerThread(config.connectorDatabaseFile);
		nextConnectionId = databaseLogger.initAndGetNextConnectionId();  // Execute on current thread, not new thread
		System.err.println("Database opened");
		
		// Listen for an incoming processor
		processorListener = new ProcessorListenerThread(this, config.connectorServerPort, config.getConnectorPassword());
		System.err.println("Listening on port " + config.connectorServerPort);
		
		// Finish the start-up
		databaseLogger.start();
		processorListener.start();
		connectionPinger = new Thread("connectionPinger") {
			public void run() {
				try {
					while (true) {
						pingConnections();
						Thread.sleep(20000);
					}
				} catch (InterruptedException e) {}
			}
		};
		connectionPinger.start();
		System.err.println("Connector ready");
	}
	
	
	
	/*---- Methods for accessing/updating global state ----*/
	
	// Should only be called from ProcessorReaderThread.
	public synchronized void listConnectionsToProcessor(OutputWriterThread writer) {
		// Dump current connection IDs and sequences to processor
		databaseLogger.flushQueue();
		writer.postWrite("active-connections");
		for (Map.Entry<Integer,ConnectionInfo> entry : serverConnections.entrySet())
			writer.postWrite(entry.getKey() + " " + entry.getValue().nextSequence);
		writer.postWrite("end-list");
	}
	
	
	// Should only be called from ProcessorReaderThread.
	public synchronized void attachProcessor(ProcessorReaderThread reader, OutputWriterThread writer) {
		// Kick out existing processor, and set fields
		if (processorReader != null)
			processorReader.terminate();  // Asynchronous termination
		processorReader = reader;
		processorWriter = writer;
		listConnectionsToProcessor(writer);
		processorWriter.postWrite("live-events");
	}
	
	
	// Should only be called from ProcessorReaderThread. Caller is responsible for its own termination.
	public synchronized void detachProcessor(ProcessorReaderThread reader) {
		if (reader == processorReader) {
			processorReader = null;
			processorWriter = null;
		}
	}
	
	
	// Should only be called from ProcessorReaderThread. Hostname and metadata must not contain '\0', '\r', or '\n'.
	public synchronized void connectServer(String hostname, int port, boolean useSsl, String metadata, ProcessorReaderThread reader) {
		if (reader != processorReader)
			return;
		ConnectionInfo info = new ConnectionInfo(nextConnectionId);
		nextConnectionId++;
		String str = "connect " + hostname + " " + port + " " + (useSsl ? "ssl" : "nossl") + " " + metadata;
		postEvent(info, Event.Type.CONNECTION, new CleanLine(str));
		serverConnections.put(info.connectionId, info);
		new ServerReaderThread(this, info.connectionId, hostname, port, useSsl).start();
	}
	
	
	// Should only be called from ProcessorReaderThread or terminateConnector().
	public synchronized void disconnectServer(int conId, ProcessorReaderThread reader) {
		if (reader != processorReader)
			return;
		ConnectionInfo info = serverConnections.get(conId);
		if (info == null)
			System.err.println("Warning: Connection " + conId + " does not exist");
		else {
			postEvent(info, Event.Type.CONNECTION, new CleanLine("disconnect"));
			info.reader.terminate();
		}
	}
	
	
	// Should only be called from ServerReaderThread.
	public synchronized void connectionOpened(int conId, InetAddress addr, ServerReaderThread reader, OutputWriterThread writer) {
		if (!serverConnections.containsKey(conId))
			throw new IllegalArgumentException("Connection ID does not exist: " + conId);
		ConnectionInfo info = serverConnections.get(conId);
		postEvent(info, Event.Type.CONNECTION, new CleanLine("opened " + addr.getHostAddress()));
		info.reader = reader;
		info.writer = writer;
	}
	
	
	// Should only be called from ServerReaderThread.
	public synchronized void connectionClosed(int conId) {
		ConnectionInfo info = serverConnections.remove(conId);
		if (info == null)
			throw new IllegalArgumentException("Connection ID does not exist: " + conId);
		postEvent(info, Event.Type.CONNECTION, new CleanLine("closed"));
	}
	
	
	// Should only be called from ServerReaderThread.
	public synchronized void receiveMessage(int conId, CleanLine line) {
		ConnectionInfo info = serverConnections.get(conId);
		if (info == null)
			throw new IllegalArgumentException("Connection ID does not exist: " + conId);
		postEvent(info, Event.Type.RECEIVE, line);
		byte[] pong = makePongIfPing(line.getDataNoCopy());
		if (pong != null)
			sendMessage(conId, new CleanLine(pong, false), processorReader);
	}
	
	
	// Should only be called from ProcessorReaderThread or receiveMessage().
	public synchronized void sendMessage(int conId, CleanLine line, ProcessorReaderThread reader) {
		if (reader != processorReader)
			return;
		ConnectionInfo info = serverConnections.get(conId);
		if (info != null && info.writer != null) {
			postEvent(info, Event.Type.SEND, line);
			info.writer.postWrite(line);
		} else
			System.err.println("Warning: Connection " + conId + " does not exist");
	}
	
	
	// Should only be called from ProcessorReaderThread.
	public void terminateConnector(ProcessorReaderThread reader) {
		Thread[] toWait;
		connectionPinger.interrupt();
		synchronized(this) {
			if (reader != processorReader)
				return;
			System.err.println("Connector terminating");
			
			toWait = new ServerReaderThread[serverConnections.size()];
			int i = 0;
			for (int conId : serverConnections.keySet()) {
				toWait[i] = serverConnections.get(conId).reader;
				disconnectServer(conId, processorReader);
				i++;
			}
			
			if (processorReader != null) {
				processorReader.terminate();
				processorReader = null;
				processorWriter = null;
			}
			processorListener.terminate();
		}
		
		try {
			for (Thread th : toWait)
				th.join();
		} catch (InterruptedException e) {}
		databaseLogger.terminate();
	}
	
	
	// Logs the event to the database, and relays another copy to the currently attached processor.
	// Must only be called from one of the synchronized methods above.
	private void postEvent(ConnectionInfo info, Event.Type type, CleanLine line) {
		Event ev = new Event(info.connectionId, info.nextSequence(), type, line);
		if (processorWriter != null) {
			try {
				ByteArrayOutputStream bout = new ByteArrayOutputStream();
				bout.write(Utils.toUtf8(String.format("%d %d %d %d ", ev.connectionId, ev.sequence, ev.timestamp, ev.type.ordinal())));
				bout.write(line.getDataNoCopy());
				processorWriter.postWrite(new CleanLine(bout.toByteArray(), false));
			} catch (IOException e) {
				throw new AssertionError(e);
			}
		}
		databaseLogger.postEvent(ev);
	}
	
	
	// Scans all currently active connections and sends a ping to each one. If a connection is bad, this write
	// soon causes the socket read() to throw an IOException, due to a reset packet or lack of acknowledgement.
	// This write is necessary because without it, the read() might keep silently blocking for minutes or hours
	// on a bad connection, depending on how the underlying platform handles socket keepalives.
	// Note that these pings are not logged to the database or relayed to the processor.
	// This method should only be called from the connectionPinger thread.
	private synchronized void pingConnections() {
		// From surveying ~5 different IRC servers, it appears that sending a blank line is always safely ignored.
		// (However, some servers give an error response to a whitespace-only line consisting of one or more spaces.)
		// This pseudo-ping is more lightweight than sending a real IRC PING command, and justifies the lack of logging.
		for (ConnectionInfo info : serverConnections.values()) {
			if (info.writer != null)
				info.writer.postWrite(BLANK_LINE);
		}
	}
	
	private static final CleanLine BLANK_LINE = new CleanLine("");
	
	
	// If the given line is a PING command, then this returns a new byte array containing an appropriate PONG response.
	// Otherwise this function returns null. This handles all inputs correctly, and safely ignores lines with illegal IRC syntax.
	static byte[] makePongIfPing(byte[] line) {
		// Skip prefix, if any
		int i = 0;
		if (line.length >= 1 && line[i] == ':') {
			i++;
			while (i < line.length && line[i] != ' ')
				i++;
			while (i < line.length && line[i] == ' ')
				i++;
		}
		
		// Check that next 4 characters are "PING" case-insensitively, followed by space or end of string
		byte[] reply = null;
		if (line.length - i >= 4 && (line[i + 0] & 0xDF) == 'P' && (line[i + 1] & 0xDF) == 'I' && (line[i + 2] & 0xDF) == 'N' && (line[i + 3] & 0xDF) == 'G'
				&& (line.length - i == 4 || line[i + 4] == ' ')) {
			// Create reply by dropping prefix, changing PING to PONG, and copying all parameters
			reply = Arrays.copyOfRange(line, i, line.length);
			reply[1] += 'O' - 'I';
		}
		return reply;
	}
	
	
	
	/*---- Helper class ----*/
	
	private static final class ConnectionInfo {
		
		public final int connectionId;     // Non-negative
		public int nextSequence;           // Non-negative
		public ServerReaderThread reader;  // Initially null, but non-null after connectionOpened() is called
		public OutputWriterThread writer;  // Initially null, but non-null after connectionOpened() is called
		
		
		public ConnectionInfo(int conId) {
			if (conId < 0)
				throw new IllegalArgumentException("Connection ID must be positive");
			connectionId = conId;
			nextSequence = 0;
			reader = null;
			writer = null;
		}
		
		
		public int nextSequence() {
			int result = nextSequence;
			nextSequence++;
			return result;
		}
		
	}
	
}
