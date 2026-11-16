import SwiftUI

@main
struct RelayMacApp: App {
    @State private var count = 0

    var body: some Scene {
        WindowGroup {
            VStack(spacing: 20) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 72))
                    .foregroundStyle(.green)
                Text(RelayModel.greeting)
                    .font(.title)
                    .accessibilityIdentifier("relay-greeting")
                Text("Count: \(count)")
                    .accessibilityIdentifier("relay-count")
                Button("Increment") { count += 1 }
                    .accessibilityIdentifier("relay-increment")
                Text("Built and launched through Factory relay")
                    .font(.subheadline)
            }
            .padding()
        }
    }
}
