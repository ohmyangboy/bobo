import Foundation

@main
enum AwakeMain {
    static func main() { exit(AwakeCLI.run(Array(CommandLine.arguments.dropFirst()))) }
}
