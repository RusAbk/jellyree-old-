package app.jellyree.mobile

import android.net.Uri
import android.provider.DocumentsContract
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File
import kotlin.concurrent.thread

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "app.jellyree.mobile/folders")
            .setMethodCallHandler { call, result ->
                val uri = (call.arguments as? String)?.let(Uri::parse)
                if (call.method != "stage" || uri?.scheme != "content") {
                    result.notImplemented()
                } else {
                    thread(name = "jellyree-folder-picker") {
                        try {
                            val path = stage(uri)
                            runOnUiThread { result.success(path) }
                        } catch (_: Exception) {
                            runOnUiThread { result.error("folder_read_failed", null, null) }
                        }
                    }
                }
            }
    }

    private fun stage(tree: Uri): String {
        val documentId = DocumentsContract.getTreeDocumentId(tree)
        val rootUri = DocumentsContract.buildDocumentUriUsingTree(tree, documentId)
        val staging = File.createTempFile("jellyree-folder-", ".tmp", cacheDir)
        check(staging.delete() && staging.mkdir())
        val nameColumn = DocumentsContract.Document.COLUMN_DISPLAY_NAME
        val idColumn = DocumentsContract.Document.COLUMN_DOCUMENT_ID
        val typeColumn = DocumentsContract.Document.COLUMN_MIME_TYPE
        val checked = mutableSetOf(documentId)
        var files = 0

        fun safeName(value: String): String {
            require(value.isNotEmpty() && value != "." && value != ".." &&
                value.none { it == '/' || it == '\\' || it.code < 32 })
            return value
        }

        fun copyFolder(id: String, folder: File, depth: Int) {
            check(depth < 64 && folder.mkdir())
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, id)
            contentResolver.query(children, arrayOf(idColumn, nameColumn, typeColumn), null, null, null)
                ?.use { cursor ->
                    while (cursor.moveToNext()) {
                        val childId = cursor.getString(0)
                        val target = File(folder, safeName(cursor.getString(1)))
                        check(!target.exists())
                        if (cursor.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR) {
                            check(checked.add(childId))
                            copyFolder(childId, target, depth + 1)
                        } else {
                            check(++files <= 10_000)
                            val child = DocumentsContract.buildDocumentUriUsingTree(tree, childId)
                            val stream = checkNotNull(contentResolver.openInputStream(child))
                            stream.use { input -> target.outputStream().use { output -> input.copyTo(output) } }
                        }
                    }
                } ?: error("Unreadable folder")
        }

        return try {
            val name = contentResolver.query(rootUri, arrayOf(nameColumn), null, null, null)
                ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
            val folder = File(staging, safeName(checkNotNull(name)))
            copyFolder(documentId, folder, 0)
            folder.path
        } catch (error: Exception) {
            staging.deleteRecursively()
            throw error
        }
    }
}
