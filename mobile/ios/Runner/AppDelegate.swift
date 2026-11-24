import Flutter
import UIKit
import UniformTypeIdentifiers

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  private let folders = LibraryFolderPicker()

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    guard let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "JellyreeFolderPicker")
    else { return }
    let channel = FlutterMethodChannel(
      name: "app.jellyree.mobile/folders", binaryMessenger: registrar.messenger()
    )
    channel.setMethodCallHandler { [weak self] call, result in
      guard call.method == "pick" else { result(FlutterMethodNotImplemented); return }
      self?.folders.pick(result)
    }
  }
}

private final class LibraryFolderPicker: NSObject, UIDocumentPickerDelegate {
  private var active: FlutterResult?

  func pick(_ result: @escaping FlutterResult) {
    guard active == nil else { result(nil); return }
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .filter { $0.activationState == .foregroundActive }
      .flatMap(\.windows)
    guard var presenter = windows.first(where: \.isKeyWindow)?.rootViewController
    else { result(nil); return }

    while let next = presenter.presentedViewController { presenter = next }
    let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
    picker.delegate = self
    active = result
    presenter.present(picker, animated: true)
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    let result = active
    active = nil
    result?(nil)
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let result = active else { return }
    active = nil
    guard let source = urls.first else { result(nil); return }

    DispatchQueue.global(qos: .userInitiated).async {
      let granted = source.startAccessingSecurityScopedResource()
      defer { if granted { source.stopAccessingSecurityScopedResource() } }
      let manager = FileManager.default
      let staging = manager.temporaryDirectory.appendingPathComponent("jellyree-folder-\(UUID().uuidString)")
      let target = staging.appendingPathComponent(source.lastPathComponent)
      do {
        try manager.createDirectory(at: staging, withIntermediateDirectories: false)
        var coordinationError: NSError?
        var copyError: Error?
        NSFileCoordinator().coordinate(readingItemAt: source, options: .withoutChanges, error: &coordinationError) { from in
          do { try manager.copyItem(at: from, to: target) }
          catch { copyError = error }
        }
        if let error = coordinationError { throw error }
        if let error = copyError { throw error }
        DispatchQueue.main.async { result(target.path) }
      } catch {
        try? manager.removeItem(at: staging)
        DispatchQueue.main.async { result(FlutterError(code: "folder_read_failed", message: nil, details: nil)) }
      }
    }
  }
}
